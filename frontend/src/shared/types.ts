/**
 * Shared types for the GPU Pool Network MVP (spec v0.1: §5 gateway, §8 credits,
 * §10 Hedera, §11 Arkiv). JSON Schema mirrors live in ../schemas/*.schema.json.
 * Keep both in sync. Amounts in HBAR are tinybar integer strings (8 decimals).
 */

export type HexAddress = `0x${string}`;

/* ── pool and nodes (Arkiv §11.2) ─────────────────────────────────────── */

/** gpupool.node status, written by the node agent. */
export type NodeStatus = "online" | "loading" | "ready" | "offline";

/** One hop of the pipeline: a node serving a half-open layer range [start, end). */
export type RouteHop = { node_id: string; layers: [number, number] };

/** Arkiv entity gpupool.node (plus the reliability parts the gateway adds on /me). */
export type NodeListing = {
  /** Node public key (EVM address of ~/.gpupool/node.key). */
  node_id: string;
  owner_account: string;
  pool_id: string;
  gpu: string;
  mem_gb: number;
  status: NodeStatus;
  layers: [number, number] | null;
  tok_s: number;
  /** 0.7 × success_rate + 0.3 × uptime_rate, 0.0 to 1.0 (§9.1). */
  reliability: number;
  /** Listing expiry (ms). 120 s, renewed every 30 s. */
  expires_at: number;
  nickname?: string;
  success_rate?: number;
  uptime_rate?: number;
};

/** Arkiv entity gpupool.pool, written by the coordinator. */
export type PoolListing = {
  pool_id: string;
  models: string[];
  members: string[];
  status: "ready" | "forming" | "offline";
  layer_map: RouteHop[];
  /** Lowest node reliability in the pool (§9.2). */
  reliability: number;
  /** 0.0 to 1.0. Router score = reliability × (1 − load). */
  load: number;
  expires_at: number;
};

/** Arkiv entity gpupool.model, written by the admin. */
export type ModelEntry = {
  model_id: string;
  mlx_variant: string | null;
  size_gb: number;
  model_factor: number;
  license: string;
  params_b: number;
  total_layers: number;
};

/** Arkiv entity gpupool.account_stats (pseudonymous), written by the gateway every 10 min. */
export type AccountStats = {
  account_id: string;
  earned: number;
  spent: number;
  ratio: number;
  reliability: number;
};

/* ── accounts and credits (§8) ────────────────────────────────────────── */

export type Balance = {
  starter: number;
  starter_expires_at: number;
  earned: number;
  held: number;
  earned_total: number;
  spent_total: number;
};

/** GET /me */
export type Me = {
  account_id: string;
  balance: Balance;
  /** earned_total / max(spent_total, 1) */
  ratio: number;
  payout_address: HexAddress | null;
  nodes: NodeListing[];
};

export type PayType = "credits" | "x402";

/** Division of one request (§8.3). A node owned by the requester gets 0; its share goes to the reserve. */
export type Split = {
  nodes: { node_id: string; layers: number; credits: number; self: boolean }[];
  burn: number;
  reserve: number;
};

/** GET /requests/:id */
export type Receipt = {
  req_id: string;
  model: string;
  pay_type: PayType;
  in_tokens: number;
  out_tokens: number;
  /** Credits for pay_type "credits"; 0 for x402 (see x402_amount). */
  cost: number;
  /** x402 price in tinybars (string), null for credits. */
  x402_amount: string | null;
  route: RouteHop[];
  split: Split | null;
  x402_tx: string | null;
  x402_payer: string | null;
  hcs_seq: number | null;
  prompt_hash: string;
  resp_hash: string;
  status: "ok" | "failed";
  ts: number;
};

/* ── ledger (HCS §8.6, §10.2) ─────────────────────────────────────────── */

export type LedgerType =
  | "account_created"
  | "starter_grant"
  | "request_settled"
  | "x402_payment"
  | "credits_expired"
  | "payout_address_set"
  | "epoch_closed"
  | "payout_claimed";

export type LedgerEvent = {
  id: string;
  type: LedgerType;
  payload: Record<string, unknown>;
  gateway_sig: string;
  /** null until the async HCS write lands. */
  hcs_seq: number | null;
  ts: number;
};

/* ── epochs and payouts (§10.5) ───────────────────────────────────────── */

export type Epoch = {
  epoch: number;
  start_ts: number;
  end_ts: number;
  total_tinybar: string;
  merkle_root: string | null;
  post_tx: string | null;
  status: "open" | "closed" | "posted";
};

/** One Merkle leaf (payout_address, amount_tinybar) with its proof. */
export type Payout = {
  epoch: number;
  payout_address: HexAddress;
  amount_tinybar: string;
  proof: HexAddress[];
  claimed: boolean;
  claim_tx: string | null;
};

/** x402 price per request (§7.3). tier512 / tier2048 in HBAR. */
export type PriceTier = { max_params_b: number; tier512: string; tier2048: string; asset: "HBAR" };
