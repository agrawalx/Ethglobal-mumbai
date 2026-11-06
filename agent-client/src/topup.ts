#!/usr/bin/env node
/**
 * Buy credits for one GPU Pool API key with testnet HBAR (x402). 1 HBAR = 10 credits (shared
 * config topup.credits_per_hbar). Only that key can spend them. SPENDS TESTNET HBAR.
 *   pnpm topup --hbar 5          # pay 5 HBAR, add 50 credits to GPUPOOL_API_KEY
 *   pnpm topup --check           # only show the key's credits
 * Env (agent-client/.env, never committed): GATEWAY_URL, GPUPOOL_API_KEY (gpa_…), and your Hedera
 * Portal testnet account: AGENT_ACCOUNT_ID (0.0.x) + AGENT_PRIVATE_KEY (DER or hex; AGENT_KEY_TYPE
 * ecdsa|ed25519 for hex). The private key stays on this machine: x402 signs here, the gateway only
 * sees the signed transfer.
 */
import { parseArgs } from "node:util";
import { x402Client } from "@x402/core/client";
import { decodePaymentResponseHeader, wrapFetchWithPayment } from "@x402/fetch";
import { createClientHederaSigner, HBAR_ASSET_ID, PrivateKey } from "@x402/hedera";
import { ExactHederaScheme } from "@x402/hedera/exact/client";
import { CreditTopupResponse, KeyCreditsResponse } from "@gpupool/shared";
import { hashscanTxUrl, hbarToTinybar, loadNetConfig, portalKeyKind } from "./budget.ts";

const { values } = parseArgs({ options: { hbar: { type: "string" }, check: { type: "boolean", default: false } } });
const env = process.env;
const need = ["GATEWAY_URL", "GPUPOOL_API_KEY", ...(values.check ? [] : ["AGENT_ACCOUNT_ID", "AGENT_PRIVATE_KEY"])];
const missing = need.filter((k) => !env[k]);
if (missing.length) {
  console.error(`missing env: ${missing.join(", ")} (see agent-client/.env.example)`);
  process.exit(1);
}
if ((env.HEDERA_NETWORK ?? "testnet") !== "testnet") {
  console.error("HEDERA_NETWORK must be testnet");
  process.exit(1);
}
const gateway = env.GATEWAY_URL!.replace(/\/+$/, "");
const auth = { authorization: `Bearer ${env.GPUPOOL_API_KEY}` };
const cr = (mc: number) => `${(mc / 1000).toLocaleString("en-US", { maximumFractionDigits: 3 })} cr`;

async function show(): Promise<void> {
  const res = await fetch(`${gateway}/v1/credits`, { headers: auth });
  if (!res.ok) throw new Error(`GET /v1/credits: HTTP ${res.status} ${await res.text()}`);
  const c = KeyCreditsResponse.parse(await res.json());
  console.log(`key ${c.name} (${c.agent_id})
  bought credits (this key only): ${cr(c.key_credits_mc)}  (bought in total ${cr(c.bought_total_mc)})
  account credits:                ${cr(c.account_available_mc)}${c.cap_mc === null ? "  (no cap)" : `  (cap ${cr(c.cap_mc)}, ${cr(c.cap_left_mc!)} left)`}
  can spend now:                  ${cr(c.spendable_mc)}
  rate: 1 HBAR = ${c.topup.credits_per_hbar} credits, ${c.topup.min_hbar}–${c.topup.max_hbar} HBAR per top-up`);
}

if (values.check) {
  await show();
  process.exit(0);
}
if (!values.hbar) {
  console.error("usage: pnpm topup --hbar <amount>   (or --check)");
  process.exit(1);
}
const cfg = loadNetConfig();
const tinybar = hbarToTinybar(values.hbar);
const hbar = Number(tinybar) / 1e8;
if (hbar < cfg.topup.min_hbar || hbar > cfg.topup.max_hbar) {
  console.error(`--hbar must be from ${cfg.topup.min_hbar} to ${cfg.topup.max_hbar}`);
  process.exit(1);
}

await show();
const network = "hedera:testnet" as const;
const raw = env.AGENT_PRIVATE_KEY!;
const kind = portalKeyKind(raw, env.AGENT_KEY_TYPE ?? "ecdsa");
const key = kind === "der" ? PrivateKey.fromStringDer(raw) : kind === "ecdsa" ? PrivateKey.fromStringECDSA(raw) : PrivateKey.fromStringED25519(raw);
const signer = createClientHederaSigner(env.AGENT_ACCOUNT_ID!, key, { network });
// Pay HBAR only, and never more than the amount asked for on the command line.
const client = new x402Client()
  .register("hedera:*", new ExactHederaScheme(signer))
  .setSpendControls({ allowedAssets: [{ network, asset: HBAR_ASSET_ID, maxAmountPerPayment: tinybar.toString() }] })
  .registerPolicy((_version, requirements) => requirements.filter((r) => r.asset === HBAR_ASSET_ID && BigInt(r.amount) === tinybar));
const pay = wrapFetchWithPayment(fetch, client);

console.log(`\npaying ${hbar} testnet HBAR from ${env.AGENT_ACCOUNT_ID} for ${hbar * cfg.topup.credits_per_hbar} credits…`);
const res = await pay(`${gateway}/v1/credits/topup`, {
  method: "POST",
  headers: { "content-type": "application/json", accept: "application/json", ...auth },
  body: JSON.stringify({ hbar }),
});
const header = res.headers.get("PAYMENT-RESPONSE");
if (header) console.log(`HashScan: ${hashscanTxUrl(decodePaymentResponseHeader(header).transaction)}`);
if (!res.ok) {
  console.error(`top-up failed: HTTP ${res.status} ${await res.text()}`);
  process.exit(1);
}
const done = CreditTopupResponse.parse(await res.json());
console.log(`added ${cr(done.added_mc)} to ${done.agent_id} (tx ${done.tx_id})\n`);
await show();
