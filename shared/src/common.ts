import { z } from "zod";

/** EVM address, 0x + 40 **lowercase** hex. Lowercase at every boundary so map keys and Arkiv queries match. */
export const EvmAddress = z.string().regex(/^0x[0-9a-f]{40}$/);
export type EvmAddress = z.infer<typeof EvmAddress>;

/** 32-byte hex value (hashes, Merkle roots, proof nodes). */
export const Hex32 = z.string().regex(/^0x[0-9a-f]{64}$/);
export type Hex32 = z.infer<typeof Hex32>;

/** Hex-encoded signature, 0x-prefixed. */
export const HexSig = z.string().regex(/^0x[0-9a-f]+$/);
export type HexSig = z.infer<typeof HexSig>;

/**
 * Credit amounts are integer **millicredits** (1 credit = 1000 mc) everywhere:
 * SQLite, HCS, and the API. No floats in the ledger, so balances rebuild exactly from HCS.
 */
export const Millicredits = z.number().int().nonnegative();
export type Millicredits = z.infer<typeof Millicredits>;

/** HBAR amounts in tinybars (1 HBAR = 1e8), as a decimal string (uint256 range). */
export const Tinybar = z.string().regex(/^(0|[1-9][0-9]*)$/);
export type Tinybar = z.infer<typeof Tinybar>;

/** Unix time in milliseconds. */
export const TimestampMs = z.number().int().nonnegative();
export type TimestampMs = z.infer<typeof TimestampMs>;

/** Epoch number = floor(epoch_start_unix_seconds / EPOCH_SECONDS). uint64 in the contract. */
export const EpochNumber = z.number().int().nonnegative();
export type EpochNumber = z.infer<typeof EpochNumber>;

export const AccountId = z.string().regex(/^acc_[A-Za-z0-9]+$/);
export type AccountId = z.infer<typeof AccountId>;

export const RequestId = z.string().regex(/^req_[A-Za-z0-9]+$/);
export type RequestId = z.infer<typeof RequestId>;

export const PoolId = z.string().min(1).max(64);
export type PoolId = z.infer<typeof PoolId>;

/** Hugging Face model ID as Parallax uses it, e.g. "Qwen/Qwen3-14B-FP8". */
export const ModelId = z.string().min(1);
export type ModelId = z.infer<typeof ModelId>;

/** Hedera account ID, e.g. "0.0.1234". */
export const HederaAccountId = z.string().regex(/^\d+\.\d+\.\d+$/);
export type HederaAccountId = z.infer<typeof HederaAccountId>;

/** Hedera transaction ID, e.g. "0.0.1234@1793912345.123456789". */
export const HederaTxId = z.string().regex(/^\d+\.\d+\.\d+@\d+\.\d+$/);
export type HederaTxId = z.infer<typeof HederaTxId>;

/** Half-open layer range [start, end), same as Parallax `/cluster/status_json`. */
export const LayerRange = z
  .tuple([z.number().int().nonnegative(), z.number().int().positive()])
  .refine(([start, end]) => start < end, "layer range start must be < end");
export type LayerRange = z.infer<typeof LayerRange>;

/** One stage of the pipeline. A route is ordered from the first layer to the last. */
export const RouteHop = z.object({
  node_id: EvmAddress,
  layers: LayerRange,
});
export type RouteHop = z.infer<typeof RouteHop>;

export const Route = z.array(RouteHop).min(1);
export type Route = z.infer<typeof Route>;

/** Division of one credit-paid request (SPEC §8.3). Parts sum exactly to the cost. */
export const CreditSplit = z.object({
  /** node_id → millicredits. A node that served its own owner's request gets 0; that share goes to reserve. */
  nodes: z.record(EvmAddress, Millicredits),
  burn_mc: Millicredits,
  /** Reserve also takes the rounding remainder. */
  reserve_mc: Millicredits,
});
export type CreditSplit = z.infer<typeof CreditSplit>;

export const PayType = z.enum(["credits", "x402"]);
export type PayType = z.infer<typeof PayType>;
