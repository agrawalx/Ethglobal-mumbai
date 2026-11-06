import type { Context } from "hono";
import { ChatCompletionRequest, REQUEST_ID_HEADER, Usage, type ModelConfig } from "@gpupool/shared";
import type { Config } from "./config.ts";
import { errorResponse } from "./errors.ts";

/** Called once per request when the answer is complete (or failed). billing.ts settles here. */
export type Completion = {
  reqId: string;
  model: string;
  usage: Usage | null;
  text: string;
  ok: boolean;
  /** Why ok is false: "pool_error", "no_usage", "client_aborted". */
  reason?: string;
};
export type OnComplete = (c: Completion) => void;

/**
 * Billing step, after the request is parsed and before it is forwarded (billing.ts): session →
 * credit hold; no session → x402 settle. Returns a Response to stop (402/403/…), or extra response
 * headers (x402 PAYMENT-RESPONSE) and `finish`, which runs once with the completion.
 */
export type Prepared = { headers: Record<string, string>; coordinatorUrl: string; finish: OnComplete };
export type Prepare = (c: Context, req: ChatCompletionRequest, model: ModelConfig, maxTokens: number, reqId: string) => Promise<Prepared | Response>;

const withHeaders = (res: Response, headers: Record<string, string>): Response => {
  for (const [k, v] of Object.entries(headers)) res.headers.set(k, v);
  return res;
};

export const logCompletion: OnComplete = (c) => {
  console.log(JSON.stringify({ msg: "completion", reqId: c.reqId, model: c.model, ok: c.ok, reason: c.reason, usage: c.usage, chars: c.text.length }));
};

/** max_tokens, else max_completion_tokens, else the config default (SPEC §5.3 hold). */
export function effectiveMaxTokens(req: ChatCompletionRequest, defaultMax: number): number {
  return req.max_tokens ?? req.max_completion_tokens ?? defaultMax;
}

/**
 * The body sent to Parallax. The request was already parsed by the shared schema, so unknown
 * fields (logprobs, …) are gone. Thinking is off unless the client set it (HANDOFF §2.2).
 */
export function upstreamBody(req: ChatCompletionRequest, maxTokens: number): Record<string, unknown> {
  const { max_completion_tokens: _drop, ...rest } = req;
  const body: Record<string, unknown> = {
    ...rest,
    max_tokens: maxTokens,
    chat_template_kwargs: { ...req.chat_template_kwargs, enable_thinking: req.chat_template_kwargs?.enable_thinking ?? false },
  };
  if (req.stream) body.stream_options = { include_usage: true };
  return body;
}

export function chatHandler(cfg: Config, prepare: Prepare) {
  return async (c: Context): Promise<Response> => {
    const reqId = c.get("reqId") as string;

    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      return errorResponse(c, 400, "bad_request", "body must be JSON");
    }
    const parsed = ChatCompletionRequest.safeParse(raw);
    if (!parsed.success) {
      const msg = parsed.error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; ");
      return errorResponse(c, 400, "bad_request", msg);
    }
    const req = parsed.data;
    const model: ModelConfig | undefined = cfg.model(req.model);
    if (!model) return errorResponse(c, 404, "model_not_found", `unknown model ${req.model}`);

    const maxTokens = effectiveMaxTokens(req, cfg.net.cost.default_max_tokens);
    const limit = model.x402_prices[model.x402_prices.length - 1]!.max_tokens;
    if (maxTokens > limit) return errorResponse(c, 400, "bad_request", `max_tokens ${maxTokens} is above the limit ${limit} for ${req.model}`);

    const prep = await prepare(c, req, model, maxTokens, reqId);
    if (prep instanceof Response) return prep;
    const onComplete = prep.finish;
    const extra = prep.headers;

    // Client disconnect (request signal) or stream cancel aborts the upstream request.
    const abort = new AbortController();
    if (c.req.raw.signal.aborted) abort.abort();
    c.req.raw.signal.addEventListener("abort", () => abort.abort(), { once: true });
    const timer = setTimeout(() => abort.abort(new Error("pool timeout")), cfg.env.POOL_TIMEOUT_MS);

    let upstream: Response;
    try {
      upstream = await fetch(new URL("/v1/chat/completions", prep.coordinatorUrl), {
        method: "POST",
        headers: { "content-type": "application/json", accept: req.stream ? "text/event-stream" : "application/json" },
        body: JSON.stringify(upstreamBody(req, maxTokens)),
        signal: abort.signal,
      });
    } catch (e) {
      clearTimeout(timer);
      const aborted = c.req.raw.signal.aborted;
      onComplete({ reqId, model: req.model, usage: null, text: "", ok: false, reason: aborted ? "client_aborted" : "pool_error" });
      return withHeaders(errorResponse(c, 502, "pool_error", `pool unreachable: ${(e as Error).message}`), extra);
    }
    // POOL_TIMEOUT_MS bounds the time to the response headers only, never the generation itself.
    clearTimeout(timer);
    if (!upstream.ok || !upstream.body) {
      const detail = (await upstream.text().catch(() => "")).slice(0, 300);
      onComplete({ reqId, model: req.model, usage: null, text: "", ok: false, reason: "pool_error" });
      return withHeaders(errorResponse(c, 502, "pool_error", `pool returned HTTP ${upstream.status}${detail ? `: ${detail}` : ""}`), extra);
    }

    if (!req.stream) {
      try {
        const body = (await upstream.json()) as Record<string, any>;
        const usage = Usage.safeParse(body.usage);
        const text = String(body.choices?.[0]?.message?.content ?? "");
        if (!usage.success) {
          onComplete({ reqId, model: req.model, usage: null, text, ok: false, reason: "no_usage" });
          return withHeaders(errorResponse(c, 502, "pool_error", "pool response has no usage"), extra);
        }
        onComplete({ reqId, model: req.model, usage: usage.data, text, ok: true });
        // The response id is the gateway req_id (shared ChatCompletionResponse).
        return withHeaders(c.json({ ...body, id: reqId, model: req.model }), extra);
      } catch (e) {
        onComplete({ reqId, model: req.model, usage: null, text: "", ok: false, reason: "pool_error" });
        return withHeaders(errorResponse(c, 502, "pool_error", `bad pool response: ${(e as Error).message}`), extra);
      }
    }

    return new Response(tapStream(upstream.body, abort, c.req.raw.signal, (usage, text, ok, reason) =>
      onComplete({ reqId, model: req.model, usage, text, ok, reason })), {
      status: 200,
      headers: {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache",
        connection: "keep-alive",
        ...extra,
        [REQUEST_ID_HEADER]: reqId,
      },
    });
  };
}

/**
 * Pass the upstream SSE bytes through unchanged, and read `usage` and `delta.content` on the way.
 * After the 200 headers are out, an upstream error cannot become a 502: we send one
 * `data: {"error":{"code":"pool_error",…}}` event and close the stream.
 */
export function tapStream(
  body: ReadableStream<Uint8Array>,
  abort: AbortController,
  clientSignal: AbortSignal,
  done: (usage: Usage | null, text: string, ok: boolean, reason?: string) => void,
): ReadableStream<Uint8Array> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buf = "";
  let text = "";
  let usage: Usage | null = null;
  let finished = false;
  const finish = (ok: boolean, reason?: string) => {
    if (finished) return;
    finished = true;
    done(usage, text, ok, reason);
  };
  const readEvents = (final: boolean) => {
    const parts = buf.split(/\r?\n\r?\n/);
    buf = final ? "" : parts.pop()!;
    for (const ev of parts) {
      for (const line of ev.split(/\r?\n/)) {
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (!data || data === "[DONE]") continue;
        try {
          const chunk = JSON.parse(data) as Record<string, any>;
          const u = Usage.safeParse(chunk.usage);
          if (u.success) usage = u.data;
          const delta = chunk.choices?.[0]?.delta?.content;
          if (typeof delta === "string") text += delta;
        } catch {
          // Not JSON: pass through, nothing to read.
        }
      }
    }
  };

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { value, done: end } = await reader.read();
        if (end) {
          buf += decoder.decode();
          readEvents(true);
          controller.close();
          finish(usage !== null, usage ? undefined : "no_usage");
          return;
        }
        buf += decoder.decode(value, { stream: true });
        readEvents(false);
        controller.enqueue(value);
      } catch (e) {
        const msg = JSON.stringify({ error: { code: "pool_error", message: `pool stream failed: ${(e as Error).message}` } });
        controller.enqueue(encoder.encode(`data: ${msg}\n\n`));
        controller.close();
        // usage already received = the answer was complete: settle it (no free inference by dropping late).
        if (usage) finish(true);
        else finish(false, clientSignal.aborted ? "client_aborted" : "pool_error");
      }
    },
    cancel() {
      // The client went away: stop the pool's work too.
      abort.abort();
      reader.cancel().catch(() => {});
      // The usage chunk comes after the last content chunk: if it is here, the answer was complete.
      if (usage) finish(true);
      else finish(false, "client_aborted");
    },
  });
}
