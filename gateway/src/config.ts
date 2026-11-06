import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { GpupoolConfig, type ModelConfig } from "@gpupool/shared";

/**
 * Gateway env (see gateway/.env.example, HANDOFF §8).
 * Required by the schema: POOL_COORDINATOR_URL, DATABASE_PATH. main.ts also needs GATEWAY_SIGNING_KEY.
 * Feature keys (World + JWT, HCS operator, x402) switch their feature on; payouts require treasury/settler keys and the contract address. Arkiv reads use RPC/chain/access key only.
 */
const opt = z.string().min(1).optional();
const emptyToUndefined = (v: unknown) => (v === "" ? undefined : v);

export const GatewayEnv = z.preprocess(
  (raw) => Object.fromEntries(Object.entries(raw as Record<string, unknown>).map(([k, v]) => [k, emptyToUndefined(v)])),
  z.object({
    PORT: z.coerce.number().int().min(0).max(65535).default(8080),
    /** The gateway is the only public service: bind all interfaces. Parallax stays on 127.0.0.1. */
    HOST: z.string().default("0.0.0.0"),
    PUBLIC_URL: z.url().optional(),
    POOL_COORDINATOR_URL: z.url(),
    DATABASE_PATH: z.string().min(1),
    /** Comma-separated frontend origins. Empty = no cross-origin access. */
    CORS_ORIGINS: z.string().default(""),
    /** Time to the pool's response headers, ms. Non-streaming Parallax answers send headers only after the
     *  whole generation (2048 tokens at ~5 tok/s ≈ 6 min), so keep this long. Generation after headers is not timed. */
    POOL_TIMEOUT_MS: z.coerce.number().int().positive().default(600_000),

    HEARTBEAT_SECONDS: z.coerce.number().int().positive().default(10),

    JWT_SECRET: opt,
    GATEWAY_SIGNING_KEY: opt,
    WORLD_APP_ID: opt,
    WORLD_RP_ID: opt,
    WORLD_RP_SIGNING_KEY: opt,
    WORLD_ACTION: opt,
    WORLD_ENVIRONMENT: opt,
    STARTER_CREDITS: z.coerce.number().int().nonnegative().optional(),
    STARTER_EXPIRY_DAYS: z.coerce.number().int().positive().optional(),
    HEDERA_NETWORK: opt,
    HEDERA_OPERATOR_ID: opt,
    HEDERA_OPERATOR_KEY: opt,
    HCS_TOPIC_ID: opt,
    HEDERA_MIRROR_URL: opt,
    HEDERA_JSON_RPC_URL: opt,
    HEDERA_CHAIN_ID: opt,
    TREASURY_ACCOUNT_ID: opt,
    TREASURY_PRIVATE_KEY: opt,
    X402_FACILITATOR_URL: opt,
    X402_NETWORK: opt,
    X402_PAY_TO: opt,
    SETTLER_PRIVATE_KEY: opt,
    PAYOUT_CONTRACT_ADDRESS: opt,
    EPOCH_SECONDS: z.coerce.number().int().positive().optional(),
    ARKIV_RPC_URL: opt,
    ARKIV_CHAIN_ID: opt,
    ARKIV_ACCESS_KEY: opt,
    ARKIV_PRIVATE_KEY: opt,
  }),
);
export type GatewayEnv = z.infer<typeof GatewayEnv>;

export type Config = {
  env: GatewayEnv;
  net: GpupoolConfig;
  corsOrigins: string[];
  model(id: string): ModelConfig | undefined;
};

export function loadNetworkConfig(): GpupoolConfig {
  const path = fileURLToPath(import.meta.resolve("@gpupool/shared/config.json"));
  return GpupoolConfig.parse(JSON.parse(readFileSync(path, "utf8")));
}

/** Throws one clear message listing every bad or missing key. */
export function loadConfig(rawEnv: Record<string, string | undefined> = process.env): Config {
  const r = GatewayEnv.safeParse(rawEnv);
  if (!r.success) {
    const lines = r.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`);
    throw new Error(`invalid gateway env (see gateway/.env.example):\n${lines.join("\n")}`);
  }
  const net = loadNetworkConfig();
  return {
    env: r.data,
    net,
    corsOrigins: r.data.CORS_ORIGINS.split(",").map((s) => s.trim()).filter(Boolean),
    model: (id) => net.models.find((m) => m.model_id === id),
  };
}
