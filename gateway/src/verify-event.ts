#!/usr/bin/env node
/**
 * Check one HCS ledger message (anyone can run this; no secrets needed):
 *   node src/verify-event.ts <seq> [gateway_pubkey_hex]
 *   node --env-file=.env src/verify-event.ts --pubkey      prints the public key of GATEWAY_SIGNING_KEY
 * Env: HCS_TOPIC_ID (default 0.0.11332608), HEDERA_MIRROR_URL (default testnet mirror).
 * Output: the event, its consensus timestamp, and "signature: valid|INVALID". Exit 1 if invalid.
 */
import { LedgerEvent } from "@gpupool/shared";
import { signerFromSeed, verifyEvent } from "./events.ts";

const [arg, pubArg] = process.argv.slice(2);
if (arg === "--pubkey") {
  if (!process.env.GATEWAY_SIGNING_KEY) throw new Error("GATEWAY_SIGNING_KEY is not set");
  console.log(signerFromSeed(process.env.GATEWAY_SIGNING_KEY).publicKeyHex);
  process.exit(0);
}
if (!arg || !/^\d+$/.test(arg)) {
  console.error("usage: verify-event.ts <seq> [gateway_pubkey_hex] | --pubkey");
  process.exit(1);
}
const pub = pubArg;
if (!pub) {
  console.error("give the gateway public key as the second argument (gateway/README.md)");
  process.exit(1);
}
const topic = process.env.HCS_TOPIC_ID ?? "0.0.11332608";
const mirror = (process.env.HEDERA_MIRROR_URL ?? "https://testnet.mirrornode.hedera.com").replace(/\/+$/, "");
const r = await fetch(`${mirror}/api/v1/topics/${topic}/messages/${arg}`);
if (!r.ok) {
  console.error(`mirror node returned HTTP ${r.status} for ${topic} #${arg}`);
  process.exit(1);
}
const msg = (await r.json()) as { message: string; consensus_timestamp: string; sequence_number: number };
const event = JSON.parse(Buffer.from(msg.message, "base64").toString("utf8")) as Record<string, unknown>;
const schemaOk = LedgerEvent.safeParse(event).success;
const ok = verifyEvent(event, pub);
console.log(JSON.stringify({ topic, seq: msg.sequence_number, consensus_timestamp: msg.consensus_timestamp, schema: schemaOk ? "valid" : "INVALID", signature: ok ? "valid" : "INVALID", event }, null, 2));
process.exit(ok && schemaOk ? 0 : 1);
