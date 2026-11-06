/**
 * x402 PoC server (HANDOFF step 1.6): GET/POST /echo behind an x402 HBAR paywall on Hedera testnet.
 * Env (.env.example): PORT, X402_FACILITATOR_URL, X402_NETWORK, X402_PAY_TO, X402_POC_MODEL, X402_POC_MAX_TOKENS.
 * The facilitator verifies + settles the payment and pays the Hedera fee (its account = tx payer).
 */
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { HTTPFacilitatorClient } from "@x402/core/server";
import { paymentMiddleware, x402ResourceServer } from "@x402/hono";
import { ExactHederaScheme } from "@x402/hedera/exact/server";
import { HBAR_ASSET_ID } from "@x402/hedera";
import { loadNetConfig, priceTinybar } from "./price.ts";

export type PocEnv = {
  facilitatorUrl: string;
  network: string;
  payTo: string;
  model: string;
  maxTokens: number;
};

export function readEnv(env: Record<string, string | undefined> = process.env): PocEnv {
  const missing = ["X402_FACILITATOR_URL", "X402_PAY_TO"].filter((k) => !env[k]);
  if (missing.length) throw new Error(`missing env: ${missing.join(", ")} (see scripts/x402-poc/.env.example)`);
  if (!/^\d+\.\d+\.\d+$/.test(env.X402_PAY_TO!)) throw new Error("X402_PAY_TO must be a Hedera account ID 0.0.x (EVM aliases are rejected by facilitators)");
  return {
    facilitatorUrl: env.X402_FACILITATOR_URL!,
    network: env.X402_NETWORK || "hedera:testnet",
    payTo: env.X402_PAY_TO!,
    model: env.X402_POC_MODEL || "Qwen/Qwen3-14B-FP8",
    maxTokens: Number(env.X402_POC_MAX_TOKENS || 512),
  };
}

export function createPocApp(e: PocEnv): Hono {
  const amount = priceTinybar(loadNetConfig(), e.model, e.maxTokens);
  const facilitator = new HTTPFacilitatorClient({ url: e.facilitatorUrl });
  const resourceServer = new x402ResourceServer(facilitator).register("hedera:*", new ExactHederaScheme());
  // Native HBAR needs an explicit AssetAmount: a "$0.01" price string would mean USDC.
  const accepts = { scheme: "exact", network: e.network as `${string}:${string}`, payTo: e.payTo, price: { asset: HBAR_ASSET_ID, amount }, maxTimeoutSeconds: 120 };
  const route = { accepts, description: `echo (priced as ${e.model}, max_tokens <= ${e.maxTokens})`, mimeType: "application/json" };

  const app = new Hono();
  app.use(paymentMiddleware({ "GET /echo": route, "POST /echo": route }, resourceServer));
  app.get("/echo", (c) => c.json({ echo: c.req.query("msg") ?? "hello", paid_tinybar: amount }));
  app.post("/echo", async (c) => c.json({ echo: await c.req.json().catch(() => null), paid_tinybar: amount }));
  app.get("/healthz", (c) => c.json({ ok: true }));
  return app;
}

if (import.meta.main) {
  let e: PocEnv;
  try {
    e = readEnv();
  } catch (err) {
    console.error((err as Error).message);
    process.exit(1);
  }
  const port = Number(process.env.PORT || 8090);
  serve({ fetch: createPocApp(e).fetch, port, hostname: "127.0.0.1" }, (i) =>
    console.log(`x402 PoC on http://127.0.0.1:${i.port}/echo  network ${e.network}  payTo ${e.payTo}  facilitator ${e.facilitatorUrl}`));
}
