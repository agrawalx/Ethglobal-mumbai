import { z } from "zod";
import {
  AccountId,
  CreditSplit,
  EpochNumber,
  EvmAddress,
  Hex32,
  HederaAccountId,
  HederaTxId,
  HexSig,
  LayerRange,
  Millicredits,
  ModelId,
  PayType,
  PoolId,
  RequestId,
  Route,
  TimestampMs,
  Tinybar,
} from "./common.ts";
import { ArkivNode, ArkivPool } from "./arkiv.ts";
import { LedgerEvent } from "./hcs.ts";

/** Gateway HTTP API (SPEC §5.2). */

// ---------- headers ----------

/** Set on every /v1/chat/completions response (streaming too). Use it with GET /requests/:id. */
export const REQUEST_ID_HEADER = "x-gpupool-request-id";
/** EIP-191 personal_sign by the node key over the raw request body (POST /nodes/heartbeat). */
export const NODE_SIGNATURE_HEADER = "x-gpupool-node-signature";

// ---------- errors ----------

export const ErrorCode = z.enum([
  "bad_request",
  "unauthorized",
  "insufficient_credits",
  "payment_required",
  "model_not_found",
  "no_pool_available",
  "node_limit_reached",
  "not_found",
  "pool_error",
  "internal",
]);
export type ErrorCode = z.infer<typeof ErrorCode>;

/** Every non-2xx response has this body (except the x402 402 body, which the x402 library owns). */
export const ErrorResponse = z.object({
  error: z.object({ code: ErrorCode, message: z.string() }),
});
export type ErrorResponse = z.infer<typeof ErrorResponse>;

// ---------- POST /v1/chat/completions (OpenAI-compatible subset) ----------

export const ChatMessage = z.object({
  role: z.enum(["system", "user", "assistant"]),
  content: z.string(),
});
export type ChatMessage = z.infer<typeof ChatMessage>;

/**
 * Unknown fields are stripped (zod default), so `logprobs` never reaches Parallax.
 * When forwarding, the gateway:
 * - sets chat_template_kwargs.enable_thinking = false unless the client sets it;
 * - sets stream_options.include_usage = true on streaming requests (needed to settle, SPEC §5.3);
 * - uses max_tokens, else max_completion_tokens, else config default_max_tokens for the hold.
 */
export const ChatCompletionRequest = z.object({
  model: ModelId,
  messages: z.array(ChatMessage).min(1),
  max_tokens: z.number().int().positive().optional(),
  /** Newer OpenAI SDKs send this instead of max_tokens. */
  max_completion_tokens: z.number().int().positive().optional(),
  stream: z.boolean().optional(),
  temperature: z.number().min(0).max(2).optional(),
  top_p: z.number().gt(0).max(1).optional(),
  seed: z.number().int().optional(),
  stop: z.union([z.string(), z.array(z.string())]).optional(),
  chat_template_kwargs: z.object({ enable_thinking: z.boolean().optional() }).optional(),
});
export type ChatCompletionRequest = z.infer<typeof ChatCompletionRequest>;

export const Usage = z.object({
  prompt_tokens: z.number().int().nonnegative(),
  completion_tokens: z.number().int().nonnegative(),
  total_tokens: z.number().int().nonnegative(),
});
export type Usage = z.infer<typeof Usage>;

/** Non-streaming response. `id` is the gateway req_id. Streaming uses OpenAI SSE chunks. */
export const ChatCompletionResponse = z.object({
  id: RequestId,
  object: z.literal("chat.completion"),
  created: z.number().int(),
  model: ModelId,
  choices: z
    .array(
      z.object({
        index: z.number().int().nonnegative(),
        message: z.object({ role: z.literal("assistant"), content: z.string() }),
        finish_reason: z.string().nullable(),
      }),
    )
    .min(1),
  usage: Usage,
});
export type ChatCompletionResponse = z.infer<typeof ChatCompletionResponse>;

// ---------- GET /v1/models ----------

export const ModelsResponse = z.object({
  object: z.literal("list"),
  data: z.array(
    z.object({
      id: ModelId,
      object: z.literal("model"),
      created: z.number().int(),
      owned_by: z.literal("gpupool"),
      model_factor: z.number().positive(),
      /** Number of ready pools that serve the model now. */
      pools: z.number().int().nonnegative(),
      source: z.literal("arkiv"),
    }),
  ),
});
export type ModelsResponse = z.infer<typeof ModelsResponse>;

// ---------- World login ----------

/**
 * POST /auth/world/rp-signature response (IDKit v4 RP signature, https://docs.world.org/world-id/idkit/signatures).
 * The gateway signs with `signRequest` from `@worldcoin/idkit-core/signing` (secp256k1, EIP-191 over
 * version ‖ nonce ‖ created_at ‖ expires_at ‖ hash_to_field(action)). The frontend builds IDKit's
 * `rp_context` = { rp_id, nonce, created_at, expires_at, signature: sig } and passes app_id, action,
 * environment to the widget. Times are unix SECONDS (IDKit's format). Valid for 300 s.
 */
export const RpSignatureResponse = z.object({
  sig: HexSig,
  nonce: Hex32,
  created_at: z.number().int().nonnegative(),
  expires_at: z.number().int().nonnegative(),
  rp_id: z.string().regex(/^rp_[0-9a-f]+$/),
  app_id: z.string().regex(/^app_[0-9a-f]+$/),
  action: z.string().min(1),
  environment: z.enum(["production", "staging"]),
});
export type RpSignatureResponse = z.infer<typeof RpSignatureResponse>;
/** POST /auth/world/verify request = the IDKit v4 result, unchanged (the gateway forwards it as is). */
export const WorldVerifyRequest = z.record(z.string(), z.unknown());
export type WorldVerifyRequest = z.infer<typeof WorldVerifyRequest>;

/** `new_account: false` = the human already has an account (UI shows "already registered"). */
export const WorldVerifyResponse = z.object({
  token: z.string().min(1),
  account_id: AccountId,
  new_account: z.boolean(),
  /** 0 when new_account is false. */
  starter_granted_mc: Millicredits,
});
export type WorldVerifyResponse = z.infer<typeof WorldVerifyResponse>;

// ---------- GET /me ----------

export const Balance = z.object({
  starter_mc: Millicredits,
  starter_expires_at: TimestampMs.nullable(),
  earned_mc: Millicredits,
  held_mc: Millicredits,
  earned_total_mc: Millicredits,
  spent_total_mc: Millicredits,
});
export type Balance = z.infer<typeof Balance>;

export const MeResponse = z.object({
  account_id: AccountId,
  payout_address: EvmAddress.nullable(),
  balance: Balance,
  /** earned_total / max(spent_total, 1). */
  ratio: z.number().nonnegative(),
  nodes: z.array(
    z.object({
      node_id: EvmAddress,
      pool_id: PoolId,
      gpu: z.string(),
      mem_gb: z.number().positive(),
      reliability: z.number().min(0).max(1),
      online: z.boolean(),
    }),
  ),
});
export type MeResponse = z.infer<typeof MeResponse>;

// ---------- POST /nodes/register (session auth) ----------

/**
 * `gpupool-node init` prints a link with these fields. The owner opens it, logs in, and the
 * frontend posts it. `node_sig` = EIP-191 personal_sign by the node key over the string
 * `gpupool-register:<node_id>:<pool_id>:<ts>` (no JSON, so Python and TS agree byte-for-byte).
 * `ts` must be < 24 hours old.
 */
export const NodeRegisterRequest = z.object({
  node_id: EvmAddress,
  pool_id: PoolId,
  gpu: z.string().min(1),
  mem_gb: z.number().positive(),
  ts: TimestampMs,
  node_sig: HexSig,
  /** SPEC §10.4. Required if the account has no payout address yet. */
  payout_address: EvmAddress.optional(),
});
export type NodeRegisterRequest = z.infer<typeof NodeRegisterRequest>;

export const NodeRegisterResponse = z.object({
  node_id: EvmAddress,
  account_id: AccountId,
  pool_id: PoolId,
});
export type NodeRegisterResponse = z.infer<typeof NodeRegisterResponse>;

// ---------- POST /nodes/heartbeat (node signature in NODE_SIGNATURE_HEADER) ----------

/** Every HEARTBEAT_SECONDS. `ts` must be within 60 s of gateway time (replay guard). */
export const NodeHeartbeat = z.object({
  node_id: EvmAddress,
  pool_id: PoolId,
  ts: TimestampMs,
  online: z.boolean(),
  model: ModelId.nullable(),
  layers: LayerRange.nullable(),
  tok_s: z.number().nonnegative().nullable(),
});
export type NodeHeartbeat = z.infer<typeof NodeHeartbeat>;

export const OkResponse = z.object({ ok: z.literal(true) });
export type OkResponse = z.infer<typeof OkResponse>;

/** POST /nodes/heartbeat response. The node agent copies these into its gpupool.node listing. */
export const HeartbeatResponse = z.object({
  ok: z.literal(true),
  owner_account: AccountId,
  reliability: z.number().min(0).max(1),
});
export type HeartbeatResponse = z.infer<typeof HeartbeatResponse>;

// ---------- GET /pools/:pool_id (no auth; the coordinator writes gpupool.pool from it) ----------

/**
 * The gateway's view of a pool, built from the latest fresh heartbeats of the pool's registered
 * nodes (SPEC §5.5). `layer_map` is null unless the reported ranges cover [0, num_layers) of one
 * config model exactly once; `status` is "ready" only then.
 */
export const PoolStateResponse = z.object({
  pool_id: PoolId,
  /** Config model IDs (not MLX variants): the mapped model, else the models the fresh nodes report. */
  models: z.array(ModelId),
  /** Registered nodes of the pool with a fresh heartbeat (online). */
  members: z.array(EvmAddress),
  status: z.enum(["ready", "loading", "offline"]),
  layer_map: Route.nullable(),
});
export type PoolStateResponse = z.infer<typeof PoolStateResponse>;

// ---------- GET /requests/:id (receipt) ----------

export const Receipt = z.object({
  req_id: RequestId,
  model: ModelId,
  pay_type: PayType,
  status: z.enum(["pending", "ok", "failed"]),
  account_id: AccountId.nullable(),
  x402_payer: HederaAccountId.nullable(),
  x402_tx: HederaTxId.nullable(),
  x402_amount_tinybar: Tinybar.nullable(),
  in_tokens: z.number().int().nonnegative().nullable(),
  out_tokens: z.number().int().nonnegative().nullable(),
  /** Credit requests only; null for x402 and failed requests. */
  cost_mc: Millicredits.nullable(),
  split: CreditSplit.nullable(),
  /** Null = route unknown (no valid layer map at request time, SPEC §5.5); node shares went to reserve. */
  route: Route.nullable(),
  prompt_hash: Hex32,
  resp_hash: Hex32.nullable(),
  /** Null until the HCS write is confirmed. */
  hcs_seq: z.number().int().nonnegative().nullable(),
  ts: TimestampMs,
});
export type Receipt = z.infer<typeof Receipt>;

// ---------- GET /network ----------

export const NetworkResponse = z.object({
  pools: z.array(
    ArkivPool.extend({
      /** Lowest node reliability in the pool (SPEC §9.2). */
      reliability: z.number().min(0).max(1),
      /** 0..1, from the gateway queue. */
      load: z.number().min(0).max(1),
    }),
  ),
  nodes: z.array(ArkivNode),
  source: z.literal("arkiv"),
});
export type NetworkResponse = z.infer<typeof NetworkResponse>;

// ---------- GET /ledger/events?limit=N ----------

export const LedgerEventsResponse = z.object({
  events: z.array(
    z.object({
      id: z.number().int().positive(),
      /** Null until the HCS write is confirmed. */
      hcs_seq: z.number().int().nonnegative().nullable(),
      event: LedgerEvent,
    }),
  ),
});
export type LedgerEventsResponse = z.infer<typeof LedgerEventsResponse>;

// ---------- GET /payouts/:address ----------

export const PayoutsResponse = z.object({
  payout_address: EvmAddress,
  payouts: z.array(
    z.object({
      epoch: EpochNumber,
      amount_tinybar: Tinybar,
      merkle_root: Hex32,
      proof: z.array(Hex32),
      claimed: z.boolean(),
      claim_tx: Hex32.nullable(),
    }),
  ),
});
export type PayoutsResponse = z.infer<typeof PayoutsResponse>;
