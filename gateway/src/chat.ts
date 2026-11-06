import type { Context } from "hono";
import { randomInt } from "node:crypto";
import { ChatCompletionRequest, REQUEST_ID_HEADER, Usage, type ModelConfig } from "@gpupool/shared";
import type { Config } from "./config.ts";
import { errorResponse } from "./errors.ts";
import { estimateInputTokens } from "./ledger.ts";
import type { StallTracker } from "./stall.ts";

/** Why an attempt or a request failed. */
export type FailReason = "pool_error" | "no_usage" | "client_aborted" | "stalled";

/** Called once per request when the answer is complete (or failed). billing.ts settles here. */
export type Completion = {
  reqId: string;
  model: string;
  usage: Usage | null;
  /** The whole answer the client received (all attempts). */
  text: string;
  ok: boolean;
  reason?: FailReason;
  /** Content chunks the LAST attempt sent (about 1 token each). */
  streamedTokens?: number;
};
export type OnComplete = (c: Completion) => void;

/**
 * Post-MVP P5.2 failover hook (billing.ts). Records the failed attempt (reliability failure for its
 * route), picks the next pool and moves the pool slot. null = no pool to try.
 */
export type Failover = (f: { reason: Exclude<FailReason, "client_aborted">; streamedTokens: number }) => Promise<{ coordinatorUrl: string; poolId: string } | null>;

/**
 * Billing step, after the request is parsed and before it is forwarded (billing.ts): session →
 * credit hold; no session → x402 settle. Returns a Response to stop (402/403/…), or extra response
 * headers (x402 PAYMENT-RESPONSE), the pool, `finish` (runs once with the completion) and `failover`.
 */
export type Prepared = { headers: Record<string, string>; coordinatorUrl: string; poolId: string; finish: OnComplete; failover?: Failover };
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

/**
 * Post-MVP P5.2: continue a broken answer on another attempt. The partial answer becomes the final
 * assistant message and the model goes on from its last token (vLLM `continue_final_message`; the
 * Parallax nodes serve chat through the vLLM Rust frontend). Output budget = what is left.
 */
export function continuationBody(req: ChatCompletionRequest, maxTokens: number, partial: string, streamedTokens: number): Record<string, unknown> {
  const body = upstreamBody(req, Math.max(1, maxTokens - streamedTokens));
  if (!partial) return body;
  body.messages = [...req.messages, { role: "assistant", content: partial }];
  body.continue_final_message = true;
  body.add_generation_prompt = false;
  return body;
}

type Attempt = { upstream: Response; abort: AbortController };
type OpenError = { message: string; stalled: boolean };

/**
 * Open one upstream request. `headerMs` bounds the time to the response headers only, never the
 * generation: POOL_TIMEOUT_MS for non-streaming (Parallax sends headers after the whole answer),
 * the first-token limit for streaming (Parallax sends stream headers at once; P5.1).
 */
async function openUpstream(url: string, body: Record<string, unknown>, stream: boolean, headerMs: number, clientSignal: AbortSignal): Promise<Attempt | OpenError> {
  const abort = new AbortController();
  const onClient = () => abort.abort();
  if (clientSignal.aborted) abort.abort();
  clientSignal.addEventListener("abort", onClient, { once: true });
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; abort.abort(new Error("pool timeout")); }, headerMs);
  try {
    const upstream = await fetch(new URL("/v1/chat/completions", url), {
      method: "POST",
      headers: { "content-type": "application/json", accept: stream ? "text/event-stream" : "application/json" },
      body: JSON.stringify(body),
      signal: abort.signal,
    });
    if (!upstream.ok || !upstream.body) {
      const detail = (await upstream.text().catch(() => "")).slice(0, 300);
      return { message: `pool returned HTTP ${upstream.status}${detail ? `: ${detail}` : ""}`, stalled: false };
    }
    return { upstream, abort };
  } catch (e) {
    return timedOut
      ? { message: `pool sent no response headers in ${headerMs} ms`, stalled: true }
      : { message: `pool unreachable: ${(e as Error).message}`, stalled: false };
  } finally {
    clearTimeout(timer);
  }
}

const isOpenError = (a: Attempt | OpenError): a is OpenError => !("upstream" in a);

export function chatHandler(cfg: Config, prepare: Prepare, stall: StallTracker) {
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
    // P6.1 needs the exact sampling seed later for a Token-DiFR replay. Keep client-provided
    // seeds; assign one when absent and send it to Parallax with every completion request.
    const req = { ...parsed.data, seed: parsed.data.seed ?? randomInt(0, 2 ** 31) };
    const model: ModelConfig | undefined = cfg.model(req.model);
    if (!model) return errorResponse(c, 404, "model_not_found", `unknown model ${req.model}`);

    const maxTokens = effectiveMaxTokens(req, cfg.net.cost.default_max_tokens);
    const limit = model.x402_prices[model.x402_prices.length - 1]!.max_tokens;
    if (maxTokens > limit) return errorResponse(c, 400, "bad_request", `max_tokens ${maxTokens} is above the limit ${limit} for ${req.model}`);

    const prep = await prepare(c, req, model, maxTokens, reqId);
    if (prep instanceof Response) return prep;
    const extra = prep.headers;
    const clientSignal = c.req.raw.signal;
    const complete = (usage: Usage | null, text: string, ok: boolean, reason?: FailReason, streamedTokens = 0) =>
      prep.finish({ reqId, model: req.model, usage, text, ok, ...(reason ? { reason } : {}), ...(streamedTokens ? { streamedTokens } : {}) });

    // P5.8: with the pool hooks on, the gateway request ID rides along; the scheduler hook logs the
    // route under it and removes the field before the node backend sees it.
    const tag = (b: Record<string, unknown>) => (cfg.env.PARALLAX_ROUTE_LOG ? { ...b, gpupool_req_id: reqId } : b);
    let failovers = 0;
    let target = { url: prep.coordinatorUrl, poolId: prep.poolId };
    /** Move to the next pool, if the config and the hook allow it. */
    const nextTarget = async (reason: Exclude<FailReason, "client_aborted">, streamedTokens: number): Promise<boolean> => {
      if (!prep.failover || failovers >= cfg.net.resilience.max_failovers || clientSignal.aborted) return false;
      failovers++;
      const next = await prep.failover({ reason, streamedTokens });
      if (!next) return false;
      console.warn(`failover ${reqId}: ${reason} after ${streamedTokens} tokens; retrying on ${next.poolId}`);
      target = { url: next.coordinatorUrl, poolId: next.poolId };
      return true;
    };

    const inputTokens = estimateInputTokens(req.messages, req.tools);
    const headerMs = req.stream ? stall.firstTokenMs(inputTokens) : cfg.env.POOL_TIMEOUT_MS;

    // Before any byte reaches the client, a failed attempt can start again from the beginning.
    let first: Attempt;
    for (;;) {
      const a = await openUpstream(target.url, tag(upstreamBody(req, maxTokens)), !!req.stream, headerMs, clientSignal);
      if (!isOpenError(a)) { first = a; break; }
      if (clientSignal.aborted) {
        complete(null, "", false, "client_aborted");
        return withHeaders(errorResponse(c, 502, "pool_error", a.message), extra);
      }
      const reason = a.stalled ? "stalled" : "pool_error";
      if (await nextTarget(reason, 0)) continue;
      complete(null, "", false, reason);
      return withHeaders(errorResponse(c, 502, "pool_error", a.message), extra);
    }

    if (!req.stream) {
      let attempt: Attempt = first;
      for (;;) {
        let failure: { reason: "pool_error" | "no_usage"; message: string; text: string };
        try {
          const body = (await attempt.upstream.json()) as Record<string, any>;
          const usage = Usage.safeParse(body.usage);
          const text = String(body.choices?.[0]?.message?.content ?? "");
          if (usage.success) {
            complete(usage.data, text, true);
            // The response id is the gateway req_id (shared ChatCompletionResponse).
            return withHeaders(c.json({ ...body, id: reqId, model: req.model }), extra);
          }
          failure = { reason: "no_usage", message: "pool response has no usage", text };
        } catch (e) {
          failure = { reason: "pool_error", message: `bad pool response: ${(e as Error).message}`, text: "" };
        }
        // Nothing was sent to the client yet: a new attempt starts from the beginning.
        if (await nextTarget(failure.reason, 0)) {
          const a = await openUpstream(target.url, tag(upstreamBody(req, maxTokens)), false, headerMs, clientSignal);
          if (!isOpenError(a)) { attempt = a; continue; }
          failure = { reason: "pool_error", message: a.message, text: "" };
        }
        complete(null, failure.text, false, clientSignal.aborted ? "client_aborted" : failure.reason);
        return withHeaders(errorResponse(c, 502, "pool_error", failure.message), extra);
      }
    }

    return new Response(proxyStream({
      first, clientSignal, stall, inputTokens,
      poolId: () => target.poolId,
      allowContinuation: cfg.net.resilience.continuation,
      reopen: async (reason, partial, streamedTokens) => {
        // Retry until an attempt opens or the failover budget is used up.
        while (await nextTarget(reason, streamedTokens)) {
          const a = await openUpstream(target.url, tag(continuationBody(req, maxTokens, partial, streamedTokens)), true, headerMs, clientSignal);
          if (!isOpenError(a)) return a;
          reason = a.stalled ? "stalled" : "pool_error";
        }
        return null;
      },
      done: complete,
    }), {
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

type StreamOptions = {
  first: Attempt;
  clientSignal: AbortSignal;
  stall: StallTracker;
  inputTokens: number;
  poolId: () => string;
  /** false: never resume after content was sent (only fail fast). */
  allowContinuation: boolean;
  /** Open the next attempt (continuation of `partial`), or null. */
  reopen: (reason: "pool_error" | "no_usage" | "stalled", partial: string, streamedTokens: number) => Promise<Attempt | null>;
  done: (usage: Usage | null, text: string, ok: boolean, reason?: FailReason, streamedTokens?: number) => void;
};

/** Read one chunk, or "stalled" after `ms`. On a stall the caller cancels the reader. */
async function readWithin(reader: ReadableStreamDefaultReader<Uint8Array>, ms: number): Promise<ReadableStreamReadResult<Uint8Array> | "stalled"> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const read = reader.read();
  read.catch(() => {});
  try {
    return await Promise.race([read, new Promise<"stalled">((res) => { timer = setTimeout(() => res("stalled"), ms); })]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Forward the upstream SSE events to the client, and read `usage` and `delta.content` on the way.
 * Events are forwarded whole and unchanged; `[DONE]` is sent once, at the real end.
 * Post-MVP P5.1/P5.2: a stall, an error event or an early end of the stream starts the next attempt
 * (comment line `: failover`), which continues the partial answer. After the 200 headers are out,
 * a final failure cannot become a 502: we send one `data: {"error":{"code":"pool_error",…}}` event.
 */
export function proxyStream(o: StreamOptions): ReadableStream<Uint8Array> {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let attempt = o.first;
  let reader = attempt.upstream.body!.getReader();
  let buf = "";
  let text = "";
  let usage: Usage | null = null;
  let attemptTokens = 0;
  let totalTokens = 0;
  let lastChunkAt: number | null = null;
  let finished = false;
  const finish = (ok: boolean, reason?: FailReason) => {
    if (finished) return;
    finished = true;
    o.done(usage, text, ok, reason, attemptTokens);
  };
  const stopAttempt = () => {
    attempt.abort.abort();
    reader.cancel().catch(() => {});
  };

  /** Parse complete events; returns the bytes to forward, or a failure seen in the events. */
  const takeEvents = (final: boolean): { out: string; failed: boolean; doneSeen: boolean } => {
    const parts = buf.split(/\r?\n\r?\n/);
    buf = final ? "" : parts.pop()!;
    let out = "";
    let failed = false;
    let doneSeen = false;
    for (const ev of parts) {
      if (!ev.trim()) continue;
      let forward = true;
      for (const line of ev.split(/\r?\n/)) {
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (data === "[DONE]") { doneSeen = true; forward = false; continue; }
        if (!data) continue;
        try {
          const chunk = JSON.parse(data) as Record<string, any>;
          if (chunk.error) { failed = true; forward = false; continue; }
          const u = Usage.safeParse(chunk.usage);
          if (u.success) usage = u.data;
          const delta = chunk.choices?.[0]?.delta?.content;
          if (typeof delta === "string" && delta.length > 0) {
            text += delta;
            attemptTokens++;
            totalTokens++;
            const now = Date.now();
            if (lastChunkAt !== null) o.stall.gap(o.poolId(), now - lastChunkAt);
            lastChunkAt = now;
          }
        } catch {
          // Not JSON: pass through, nothing to read.
        }
      }
      if (failed) break;
      if (forward) out += `${ev}\n\n`;
    }
    return { out, failed, doneSeen };
  };

  /** Failure of the current attempt: try the next one, else end the stream. */
  const fail = async (controller: ReadableStreamDefaultController<Uint8Array>, reason: "pool_error" | "no_usage" | "stalled", message: string): Promise<void> => {
    stopAttempt();
    // usage already received = the answer was complete: settle it (no free inference by dropping late).
    if (usage) { controller.enqueue(encoder.encode("data: [DONE]\n\n")); controller.close(); finish(true); return; }
    if (o.clientSignal.aborted) { controller.close(); finish(false, "client_aborted"); return; }
    const next = o.allowContinuation || totalTokens === 0 ? await o.reopen(reason, text, totalTokens) : null;
    if (next) {
      controller.enqueue(encoder.encode(": failover\n\n"));
      attempt = next;
      reader = next.upstream.body!.getReader();
      buf = "";
      attemptTokens = 0;
      lastChunkAt = null;
      return;
    }
    const msg = JSON.stringify({ error: { code: "pool_error", message } });
    controller.enqueue(encoder.encode(`data: ${msg}\n\n`));
    controller.close();
    finish(false, o.clientSignal.aborted ? "client_aborted" : reason);
  };

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      // Loop until something is forwarded or the stream ends (a failover may yield no bytes).
      for (;;) {
        const limit = totalTokens === 0 ? o.stall.firstTokenMs(o.inputTokens) : o.stall.stallMs(o.poolId());
        let r: ReadableStreamReadResult<Uint8Array> | "stalled";
        try {
          r = await readWithin(reader, limit);
        } catch (e) {
          if (finished) return;
          return fail(controller, "pool_error", `pool stream failed: ${(e as Error).message}`);
        }
        if (finished) return;
        if (r === "stalled") {
          if (o.clientSignal.aborted) { stopAttempt(); controller.close(); finish(false, "client_aborted"); return; }
          await fail(controller, "stalled", `pool stream stalled for ${limit} ms`);
          if (finished) return;
          continue;
        }
        if (r.done) {
          buf += decoder.decode();
          const { out, failed } = takeEvents(true);
          if (out) controller.enqueue(encoder.encode(out));
          if (usage && !failed) {
            controller.enqueue(encoder.encode("data: [DONE]\n\n"));
            controller.close();
            finish(true);
            return;
          }
          await fail(controller, failed ? "pool_error" : "no_usage", failed ? "pool sent an error event" : "pool stream ended without usage");
          if (finished) return;
          continue;
        }
        buf += decoder.decode(r.value, { stream: true });
        const { out, failed, doneSeen } = takeEvents(false);
        if (out) controller.enqueue(encoder.encode(out));
        if (doneSeen && usage && !failed) {
          stopAttempt();
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          controller.close();
          finish(true);
          return;
        }
        if (failed) {
          await fail(controller, "pool_error", "pool sent an error event");
          if (finished) return;
          continue;
        }
        if (out) return;
      }
    },
    cancel() {
      // The client went away: stop the pool's work too.
      stopAttempt();
      // The usage chunk comes after the last content chunk: if it is here, the answer was complete.
      if (usage) finish(true);
      else finish(false, "client_aborted");
    },
  });
}
