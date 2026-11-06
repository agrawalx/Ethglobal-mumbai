import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { GpupoolConfig } from "@gpupool/shared";

export const loadNetConfig = (): GpupoolConfig =>
  GpupoolConfig.parse(JSON.parse(readFileSync(fileURLToPath(import.meta.resolve("@gpupool/shared/config.json")), "utf8")));

/** x402 price (SPEC §7.3): the first tier whose max_tokens >= the request's. Tinybar decimal string. */
export function priceTinybar(cfg: GpupoolConfig, modelId: string, maxTokens: number): string {
  const m = cfg.models.find((x) => x.model_id === modelId);
  if (!m) throw new Error(`unknown model ${modelId}`);
  const tier = m.x402_prices.find((t) => maxTokens <= t.max_tokens);
  if (!tier) throw new Error(`max_tokens ${maxTokens} is above the last tier for ${modelId}`);
  return tier.price_tinybar;
}

/** Hedera tx ID "0.0.x@sec.nanos" → HashScan URL (dash form, also the mirror-node form). */
export function hashscanTxUrl(txId: string, base = "https://hashscan.io/testnet"): string {
  const m = /^(\d+\.\d+\.\d+)@(\d+)\.(\d+)$/.exec(txId);
  if (!m) throw new Error(`not a Hedera tx ID: ${txId}`);
  return `${base.replace(/\/+$/, "")}/transaction/${m[1]}-${m[2]}-${m[3]}`;
}
