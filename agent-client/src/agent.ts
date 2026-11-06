#!/usr/bin/env node
/**
 * AI agent client (SPEC §13, HANDOFF step 2.4). Asks questions to the gateway WITHOUT a session,
 * so each request is paid with x402 (HBAR on Hedera testnet). SPENDS TESTNET HBAR.
 *   node --env-file=.env src/agent.ts [--questions N] [--model M] [--max-tokens T]
 * Env: GATEWAY_URL, AGENT_ACCOUNT_ID, AGENT_PRIVATE_KEY (ECDSA), AGENT_BUDGET_HBAR, HEDERA_NETWORK.
 * Budget: before each question the price comes from the shared config tier; the agent stops
 * before a payment would take the total above AGENT_BUDGET_HBAR. The x402 client is also capped
 * per payment at the remaining budget, so a gateway that asks more is refused.
 */
import { parseArgs } from "node:util";
import { x402Client } from "@x402/core/client";
import { decodePaymentResponseHeader, wrapFetchWithPayment } from "@x402/fetch";
import { createClientHederaSigner, HBAR_ASSET_ID, PrivateKey } from "@x402/hedera";
import { ExactHederaScheme } from "@x402/hedera/exact/client";
import { REQUEST_ID_HEADER } from "@gpupool/shared";
import { canAfford, hashscanTxUrl, hbarToTinybar, loadNetConfig, priceTinybar } from "./budget.ts";

const QUESTIONS = [
  "In one sentence: what is pipeline parallelism in LLM inference?",
  "Name two benefits of splitting a model across several consumer GPUs.",
  "What does a KV cache store?",
  "Why does a distributed pool need a reliability score?",
  "Give a one-line definition of a Merkle proof.",
];

const { values } = parseArgs({ options: { questions: { type: "string", default: "5" }, model: { type: "string", default: "Qwen/Qwen3-14B-FP8" }, "max-tokens": { type: "string", default: "128" }, asset: { type: "string" } } });
const env = process.env;
const missing = ["GATEWAY_URL", "AGENT_ACCOUNT_ID", "AGENT_PRIVATE_KEY"].filter((k) => !env[k]);
if (missing.length) {
  console.error(`missing env: ${missing.join(", ")} (see agent-client/.env.example)`);
  process.exit(1);
}
if ((env.HEDERA_NETWORK ?? "testnet") !== "testnet") {
  console.error("HEDERA_NETWORK must be testnet");
  process.exit(1);
}
const network = "hedera:testnet" as const;
const cfg = loadNetConfig();
const paymentAsset = values.asset ?? env.AGENT_PAYMENT_ASSET ?? "hbar";
if (paymentAsset !== "hbar" && paymentAsset !== "usdc") throw new Error("--asset must be hbar or usdc");
const assetId = paymentAsset === "usdc" ? cfg.x402_usdc.token_id : HBAR_ASSET_ID;
const rate = paymentAsset === "usdc" ? BigInt(cfg.x402_usdc.tinybar_per_unit) : 1n;
const model = values.model!;
const maxTokens = Number(values["max-tokens"]);
const count = Math.min(Number(values.questions), QUESTIONS.length);
const budget = hbarToTinybar(env.AGENT_BUDGET_HBAR ?? "1");
const signer = createClientHederaSigner(env.AGENT_ACCOUNT_ID!, PrivateKey.fromStringECDSA(env.AGENT_PRIVATE_KEY!), { network });
const gateway = env.GATEWAY_URL!.replace(/\/+$/, "");

let spent = 0n;
for (const question of QUESTIONS.slice(0, count)) {
  const tierPrice = priceTinybar(cfg, model, maxTokens);
  const priceRaw = (tierPrice + rate - 1n) / rate;
  const price = priceRaw * rate;
  if (!canAfford(spent, price, budget)) {
    console.log(`budget: stop. spent ${spent} + next ${price} tinybar > budget ${budget} tinybar`);
    break;
  }
  // Per-payment cap = what is left of the budget (the default spend controls block HBAR).
  const client = new x402Client()
    .register("hedera:*", new ExactHederaScheme(signer))
    .setSpendControls({ allowedAssets: [{ network, asset: assetId, maxAmountPerPayment: priceRaw.toString() }] })
    .registerPolicy((_version, requirements) => requirements.filter((r) => r.asset === assetId));
  const pay = wrapFetchWithPayment(fetch, client);
  console.log(`\nQ: ${question}`);
  const res = await pay(`${gateway}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ model, messages: [{ role: "user", content: question }], max_tokens: maxTokens }),
  });
  const reqId = res.headers.get(REQUEST_ID_HEADER);
  const header = res.headers.get("PAYMENT-RESPONSE");
  if (header) {
    const settle = decodePaymentResponseHeader(header);
    spent += price;
    console.log(`paid ${priceRaw} base units of ${paymentAsset} (${price} tinybar equivalent), tx ${settle.transaction}\nHashScan: ${hashscanTxUrl(settle.transaction)}`);
  }
  const body = (await res.json().catch(() => null)) as any;
  if (!res.ok) {
    console.error(`HTTP ${res.status}: ${JSON.stringify(body)} (request ${reqId})`);
    if (!header) break; // not paid: stop rather than loop on an error
    continue;
  }
  console.log(`A: ${body?.choices?.[0]?.message?.content ?? ""}`);
  console.log(`receipt: ${gateway}/requests/${reqId}`);
}
console.log(`\nspent ${spent} tinybar (${Number(spent) / 1e8} HBAR) of budget ${Number(budget) / 1e8} HBAR`);
