import { z } from "zod";
import { AccountId, EvmAddress, Hex32, LayerRange, ModelId, PoolId, Route } from "./common.ts";

/**
 * Arkiv entities (SPEC §11.2). Each schema is the full logical record.
 * `ARKIV_INDEXED` lists the fields that the writer stores as queryable annotations;
 * the rest go in the payload. `type` is always an indexed annotation.
 */

export const ARKIV_ENTITY = {
  node: "gpupool.node",
  pool: "gpupool.pool",
  model: "gpupool.model",
  accountStats: "gpupool.account_stats",
} as const;

export const ArkivNode = z.object({
  type: z.literal(ARKIV_ENTITY.node),
  owner_account: AccountId,
  node_id: EvmAddress,
  pool_id: PoolId,
  gpu: z.string().min(1),
  mem_gb: z.number().positive(),
  status: z.enum(["online", "loading", "offline"]),
  layers: LayerRange.nullable(),
  tok_s: z.number().nonnegative().nullable(),
  reliability: z.number().min(0).max(1),
});
export type ArkivNode = z.infer<typeof ArkivNode>;

export const ArkivPool = z.object({
  type: z.literal(ARKIV_ENTITY.pool),
  pool_id: PoolId,
  /** Router query: pools that list a model. MVP pools serve one model. */
  models: z.array(ModelId).min(1),
  members: z.array(EvmAddress),
  status: z.enum(["ready", "loading", "offline"]),
  /** keccak256 of the coordinator URL. The URL itself stays private. */
  coordinator_url_hash: Hex32,
  /** Null while the pool has no valid layer map (status is then not "ready"). */
  layer_map: Route.nullable(),
  /**
   * Pool reliability (SPEC §9.2): 0.7 × pool success rate + 0.3 × pool uptime, computed by the
   * gateway for the pool as one identity. Published for consumers; the router uses the gateway's own value.
   */
  reliability: z.number().min(0).max(1),
  context_length: z.number().int().positive().optional(),
});
export type ArkivPool = z.infer<typeof ArkivPool>;

export const ArkivModel = z.object({
  type: z.literal(ARKIV_ENTITY.model),
  model_id: ModelId,
  mlx_variant: ModelId,
  size_gb: z.number().positive(),
  model_factor: z.number().positive(),
  license: z.string().min(1),
});
export type ArkivModel = z.infer<typeof ArkivModel>;

export const ArkivAccountStats = z.object({
  type: z.literal(ARKIV_ENTITY.accountStats),
  /** Pseudonymous: the gateway account ID, never the World nullifier. */
  account_id: AccountId,
  earned_mc: z.number().int().nonnegative(),
  spent_mc: z.number().int().nonnegative(),
  ratio: z.number().nonnegative(),
  /** Lowest reliability of the account's nodes; null if it has no nodes. */
  reliability: z.number().min(0).max(1).nullable(),
});
export type ArkivAccountStats = z.infer<typeof ArkivAccountStats>;

export const ARKIV_INDEXED = {
  [ARKIV_ENTITY.node]: ["type", "owner_account", "node_id", "pool_id", "gpu", "status"],
  [ARKIV_ENTITY.pool]: ["type", "pool_id", "models", "status"],
  [ARKIV_ENTITY.model]: ["type", "model_id"],
  [ARKIV_ENTITY.accountStats]: ["type", "account_id"],
} as const;
