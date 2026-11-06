/**
 * x402 PoC client: pays GET /echo in HBAR on Hedera testnet and prints the HashScan link.
 * Env (.env.example): X402_POC_URL, AGENT_ACCOUNT_ID, AGENT_PRIVATE_KEY, AGENT_KEY_TYPE, AGENT_BUDGET_HBAR, HEDERA_NETWORK.
 * SPENDS TESTNET HBAR when run.
 */
import { x402Client } from "@x402/core/client";
import { decodePaymentResponseHeader, wrapFetchWithPayment } from "@x402/fetch";
// Import Hedera SDK primitives from @x402/hedera (a second SDK copy breaks at runtime).
import { createClientHederaSigner, HBAR_ASSET_ID, PrivateKey } from "@x402/hedera";
import { ExactHederaScheme } from "@x402/hedera/exact/client";
import { hashscanTxUrl } from "./price.ts";

const env = process.env;
const missing = ["AGENT_ACCOUNT_ID", "AGENT_PRIVATE_KEY"].filter((k) => !env[k]);
if (missing.length) {
  console.error(`missing env: ${missing.join(", ")} (see scripts/x402-poc/.env.example)`);
  process.exit(1);
}
const network = (env.HEDERA_NETWORK === "mainnet" ? "hedera:mainnet" : "hedera:testnet") as `${string}:${string}`;
const key = env.AGENT_KEY_TYPE === "ed25519" ? PrivateKey.fromStringED25519(env.AGENT_PRIVATE_KEY!) : PrivateKey.fromStringECDSA(env.AGENT_PRIVATE_KEY!);
// Per-payment cap = the whole budget (the PoC makes one payment). Default spend controls block HBAR.
const capTinybar = BigInt(Math.round(Number(env.AGENT_BUDGET_HBAR || "1") * 1e8)).toString();

const signer = createClientHederaSigner(env.AGENT_ACCOUNT_ID!, key, { network });
const client = new x402Client()
  .register("hedera:*", new ExactHederaScheme(signer))
  .setSpendControls({ allowedAssets: [{ network, asset: HBAR_ASSET_ID, maxAmountPerPayment: capTinybar }] });
const pay = wrapFetchWithPayment(fetch, client);

const url = env.X402_POC_URL || "http://127.0.0.1:8090/echo?msg=hello";
const res = await pay(url);
console.log(`HTTP ${res.status}`, await res.text());
const header = res.headers.get("PAYMENT-RESPONSE") ?? res.headers.get("X-PAYMENT-RESPONSE");
if (!header) {
  console.error("no PAYMENT-RESPONSE header: payment was not settled");
  process.exit(1);
}
const settle = decodePaymentResponseHeader(header);
console.log(JSON.stringify(settle));
if (settle.transaction) console.log(`HashScan: ${hashscanTxUrl(settle.transaction, env.HASHSCAN_URL)}`);
