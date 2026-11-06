import type { Context } from "hono";
import { HTTPFacilitatorClient, x402HTTPResourceServer, x402ResourceServer, type HTTPAdapter, type HTTPRequestContext, type HTTPResponseInstructions } from "@x402/core/server";
import { HBAR_ASSET_ID, isHbarAsset } from "@x402/hedera";
import { ExactHederaScheme } from "@x402/hedera/exact/server";
import type { ChatCompletionRequest, GpupoolConfig } from "@gpupool/shared";

/**
 * x402 for /v1/chat/completions requests without a session (SPEC §7). Uses @x402/core directly,
 * not the @x402/hono middleware, because:
 *  - the price depends on the body (model + max_tokens tier), and the request was already parsed;
 *  - SPEC §7.2 settles BEFORE serving, while the middleware settles after the handler and buffers
 *    the whole response (no streaming).
 * Flow: no PAYMENT-SIGNATURE → 402 + PAYMENT-REQUIRED header (library-owned body). With it → the
 * facilitator verifies → we settle at once → serve. If the pool fails after settlement the money
 * stays with the treasury (refunds are out of scope; the request row is marked failed).
 */

export const X402_ROUTE = "POST /v1/chat/completions";

/** SPEC §7.3: first tier with tier.max_tokens >= max_tokens. Tinybar decimal string. */
export function priceTinybar(cfg: GpupoolConfig, modelId: string, maxTokens: number): string {
  const m = cfg.models.find((x) => x.model_id === modelId);
  if (!m) throw new Error(`unknown model ${modelId}`);
  const tier = m.x402_prices.find((t) => maxTokens <= t.max_tokens);
  if (!tier) throw new Error(`max_tokens ${maxTokens} is above the last tier for ${modelId}`);
  return tier.price_tinybar;
}

/** SPEC §16.4: USDC price in base units = ceil(HBAR tier price / tinybar_per_unit). */
export function priceUsdcUnits(cfg: GpupoolConfig, modelId: string, maxTokens: number): string {
  const tinybar = BigInt(priceTinybar(cfg, modelId, maxTokens));
  const rate = BigInt(cfg.x402_usdc.tinybar_per_unit);
  return ((tinybar + rate - 1n) / rate).toString();
}

export type X402Paid = { payer: string; tx: string; amountTinybar: string; asset: "hbar" | "usdc"; amountRaw: string; headers: Record<string, string> };
export type X402 = { charge(c: Context, req: ChatCompletionRequest, maxTokens: number): Promise<X402Paid | Response> };

/** Body for the price callback. The handler has already parsed and checked the request. */
type Priced = { model: string; maxTokens: number };

function adapter(c: Context, priced: Priced): HTTPAdapter {
  return {
    getHeader: (n) => c.req.header(n),
    getMethod: () => c.req.method,
    getPath: () => c.req.path,
    getUrl: () => c.req.url,
    getAcceptHeader: () => c.req.header("accept") ?? "",
    getUserAgent: () => c.req.header("user-agent") ?? "",
    getBody: () => priced,
  };
}

const toResponse = (r: HTTPResponseInstructions): Response => {
  const headers = new Headers(r.headers);
  if (r.isHtml) {
    headers.set("content-type", "text/html; charset=utf-8");
    return new Response(String(r.body ?? ""), { status: r.status, headers });
  }
  headers.set("content-type", "application/json");
  return new Response(JSON.stringify(r.body ?? {}), { status: r.status, headers });
};

export function createX402(opts: { cfg: GpupoolConfig; facilitatorUrl: string; network: string; payTo: string; acceptUsdc?: boolean }): X402 {
  if (!/^\d+\.\d+\.\d+$/.test(opts.payTo)) throw new Error("X402_PAY_TO must be a Hedera account ID 0.0.x (facilitators reject EVM aliases)");
  const facilitator = new HTTPFacilitatorClient({ url: opts.facilitatorUrl });
  const server = new x402ResourceServer(facilitator).register("hedera:*", new ExactHederaScheme());
  const http = new x402HTTPResourceServer(server, {
    [X402_ROUTE]: {
      accepts: [{
        scheme: "exact",
        network: opts.network as `${string}:${string}`,
        payTo: opts.payTo,
        // Native HBAR (asset 0.0.0), tinybars. A "$" price string would mean USDC.
        price: async (ctx: HTTPRequestContext) => {
          const p = (await ctx.adapter.getBody?.()) as Priced;
          return { asset: HBAR_ASSET_ID, amount: priceTinybar(opts.cfg, p.model, p.maxTokens) };
        },
        maxTimeoutSeconds: 120,
      }, ...(opts.acceptUsdc ? [{
        // SPEC §16.4: USDC (HTS token) at the fixed rate in shared config. The payer must be associated with the token.
        scheme: "exact",
        network: opts.network as `${string}:${string}`,
        payTo: opts.payTo,
        price: async (ctx: HTTPRequestContext) => {
          const p = (await ctx.adapter.getBody?.()) as Priced;
          return { asset: opts.cfg.x402_usdc.token_id, amount: priceUsdcUnits(opts.cfg, p.model, p.maxTokens) };
        },
        maxTimeoutSeconds: 120,
      }] : [])],
      description: "gpupool chat completion (priced by model and max_tokens tier, SPEC §7.3)",
      mimeType: "application/json",
    },
  });
  // The facilitator's /supported is fetched once, on the first paid request (retried if it fails).
  let init: Promise<void> | null = null;
  const ready = async () => {
    init ??= http.initialize().catch((e) => {
      init = null;
      throw e;
    });
    await init;
  };

  return {
    async charge(c, req, maxTokens) {
      try {
        await ready();
      } catch (e) {
        return Response.json({ error: { code: "internal", message: `x402 facilitator unreachable: ${(e as Error).message}` } }, { status: 502 });
      }
      const ctx: HTTPRequestContext = {
        adapter: adapter(c, { model: req.model, maxTokens }),
        path: c.req.path,
        method: c.req.method,
        paymentHeader: c.req.header("payment-signature") ?? c.req.header("x-payment"),
      };
      const result = await http.processHTTPRequest(ctx);
      if (result.type === "no-payment-required") throw new Error("x402 route config does not match /v1/chat/completions");
      if (result.type === "payment-error") return toResponse(result.response);
      // Settle now, before the pool runs (SPEC §7.2 steps 4–5).
      const settled = result.beforeHandlerSettlement?.result
        ? { ...result.beforeHandlerSettlement.result, headers: http.createCompletedSettlementHeaders(result.beforeHandlerSettlement) }
        : await http.processSettlement(result.paymentPayload, result.paymentRequirements, result.declaredExtensions, { request: ctx });
      if (!settled.success) return "response" in settled ? toResponse(settled.response) : Response.json({ error: { code: "payment_required", message: "settlement failed" } }, { status: 402 });
      if (!settled.payer) return Response.json({ error: { code: "internal", message: "facilitator settled without a payer" } }, { status: 502 });
      // The accepted option decides the asset. USDC income counts toward the epoch in HBAR at the fixed rate.
      const raw = settled.amount ?? result.paymentRequirements.amount;
      const usdc = !isHbarAsset(result.paymentRequirements.asset);
      if (usdc && result.paymentRequirements.asset !== opts.cfg.x402_usdc.token_id) return Response.json({ error: { code: "payment_required", message: `asset ${result.paymentRequirements.asset} is not accepted` } }, { status: 402 });
      const amountTinybar = usdc ? (BigInt(raw) * BigInt(opts.cfg.x402_usdc.tinybar_per_unit)).toString() : raw;
      return { payer: settled.payer, tx: settled.transaction, amountTinybar, asset: usdc ? "usdc" : "hbar", amountRaw: raw, headers: settled.headers };
    },
  };
}
