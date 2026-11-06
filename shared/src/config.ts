import { z } from "zod";
import { ModelId, Tinybar } from "./common.ts";

/**
 * Static network config: `shared/config/gpupool.config.json`.
 * Values that are already env keys (STARTER_CREDITS, STARTER_EXPIRY_DAYS, EPOCH_SECONDS,
 * HEARTBEAT_SECONDS, ARKIV_EXTEND_SECONDS) are NOT repeated here.
 * Shares are basis points (10000 = 100%) so the money math stays integer.
 */

export const X402PriceTier = z.object({
  /** Tier applies when request max_tokens <= this value. Tiers are sorted ascending. */
  max_tokens: z.number().int().positive(),
  price_tinybar: Tinybar,
});
export type X402PriceTier = z.infer<typeof X402PriceTier>;

export const ModelConfig = z.object({
  model_id: ModelId,
  /** Variant that Mac (MLX) nodes load. */
  mlx_variant: ModelId,
  size_gb: z.number().positive(),
  /** Transformer layers (HF config num_hidden_layers). A route must cover [0, num_layers) exactly once (SPEC §5.5). */
  num_layers: z.number().int().positive(),
  /** Cost multiplier (SPEC §8.1). 1.0 = 8B at 8 bits. */
  model_factor: z.number().positive(),
  license: z.string().min(1),
  /** SPEC §7.3. A request with max_tokens above the last tier is rejected. */
  x402_prices: z.array(X402PriceTier).min(1),
});
export type ModelConfig = z.infer<typeof ModelConfig>;

const Bps = z.number().int().min(0).max(10000);

export const GpupoolConfig = z.object({
  models: z.array(ModelConfig).min(1),
  /** Hold = model_factor × (max_tokens + input_token_weight × input_tokens). */
  cost: z.object({
    input_token_weight: z.number().nonnegative(),
    /** Used for the hold when the request has no max_tokens. */
    default_max_tokens: z.number().int().positive(),
  }),
  /** SPEC §8.3: 90 / 5 / 5. */
  credit_split_bps: z
    .object({ nodes: Bps, burn: Bps, reserve: Bps })
    .refine((s) => s.nodes + s.burn + s.reserve === 10000, "credit split must sum to 10000"),
  /** SPEC §10.5: 80 / 10 / 10. */
  x402_split_bps: z
    .object({ providers: Bps, reserve: Bps, operations: Bps })
    .refine((s) => s.providers + s.reserve + s.operations === 10000, "x402 split must sum to 10000"),
  /** SPEC §9.1. */
  reliability: z.object({
    success_weight: z.number().min(0).max(1),
    uptime_weight: z.number().min(0).max(1),
    initial_score: z.number().min(0).max(1),
    window_days: z.number().int().positive(),
  }),
  /** SPEC §5.4. */
  router: z.object({
    pool_heartbeat_max_age_s: z.number().int().positive(),
    retry_after_s: z.number().int().positive(),
  }),
  /** SPEC §11.2 expiries, in seconds. */
  arkiv_ttl_s: z.object({
    node: z.number().int().positive(),
    pool: z.number().int().positive(),
    model: z.number().int().positive(),
    account_stats: z.number().int().positive(),
  }),
  /** SPEC §11.4. */
  arkiv_account_stats_update_s: z.number().int().positive(),
  /** SPEC §6.3. */
  max_nodes_per_account: z.number().int().positive(),
  /** SPEC §6.2: JWT lifetime. */
  session_ttl_s: z.number().int().positive(),
  /** SPEC §14: transcripts kept for this many days. */
  transcript_retention_days: z.number().int().positive(),
});
export type GpupoolConfig = z.infer<typeof GpupoolConfig>;
