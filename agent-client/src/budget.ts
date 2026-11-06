import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { GpupoolConfig } from "@gpupool/shared";

export const loadNetConfig = (): GpupoolConfig =>
  GpupoolConfig.parse(JSON.parse(readFileSync(fileURLToPath(import.meta.resolve("@gpupool/shared/config.json")), "utf8")));

/** x402 price (SPEC §7.3, same rule as the gateway): first tier with tier.max_tokens >= max_tokens. Tinybars. */
export function priceTinybar(cfg: GpupoolConfig, modelId: string, maxTokens: number): bigint {
  const m = cfg.models.find((x) => x.model_id === modelId);
  if (!m) throw new Error(`unknown model ${modelId}`);
  const tier = m.x402_prices.find((t) => maxTokens <= t.max_tokens);
  if (!tier) throw new Error(`max_tokens ${maxTokens} is above the last tier for ${modelId}`);
  return BigInt(tier.price_tinybar);
}

/** "1.5" HBAR → 150000000 tinybars (exact decimal, no float). */
export function hbarToTinybar(hbar: string): bigint {
  const m = /^(\d+)(?:\.(\d{0,8}))?$/.exec(hbar.trim());
  if (!m) throw new Error(`not an HBAR amount with at most 8 decimals: ${hbar}`);
  return BigInt(m[1]!) * 100_000_000n + BigInt((m[2] ?? "").padEnd(8, "0") || "0");
}

/** Budget cap (SPEC §13): pay the next request only if it does not take the total above the budget. */
export function canAfford(spent: bigint, price: bigint, budget: bigint): boolean {
  return spent + price <= budget;
}

/** Hedera tx ID "0.0.x@sec.nanos" → HashScan URL. */
export function hashscanTxUrl(txId: string, network = "testnet"): string {
  const m = /^(\d+\.\d+\.\d+)@(\d+)\.(\d+)$/.exec(txId);
  if (!m) throw new Error(`not a Hedera tx ID: ${txId}`);
  return `https://hashscan.io/${network}/transaction/${m[1]}-${m[2]}-${m[3]}`;
}

/**
 * How to read a Hedera Portal private key: DER ("302e…" ED25519 / "3030…" ECDSA, the Portal's
 * "DER Encoded" field) carries its type; a raw 32-byte hex key needs AGENT_KEY_TYPE (default ecdsa).
 */
export function portalKeyKind(raw: string, type = "ecdsa"): "der" | "ecdsa" | "ed25519" {
  const k = raw.trim().replace(/^0x/, "");
  if (/^30[0-9a-f]{2,}$/i.test(k) && k.length > 64) return "der";
  if (!/^[0-9a-f]{64}$/i.test(k)) throw new Error("AGENT_PRIVATE_KEY must be the Portal's DER or 64-hex private key");
  if (type !== "ecdsa" && type !== "ed25519") throw new Error("AGENT_KEY_TYPE must be ecdsa or ed25519");
  return type;
}
