import type {
  AccountStats,
  Epoch,
  LedgerEvent,
  LedgerType,
  Me,
  ModelEntry,
  NodeListing,
  Payout,
  PoolListing,
  Receipt,
  RouteHop,
} from "@shared/types";

/** One streamed chunk of a playground reply. */
export type ChatChunk = {
  delta: string;
  tok_s?: number;
  ttft_ms?: number;
  route?: RouteHop[];
  done?: boolean;
  receipt_id?: string;
};

export type ChatBody = {
  model: string;
  messages: { role: "system" | "user" | "assistant"; content: string }[];
  max_tokens: number;
};

/** World ID 4 RP context, signed by the gateway (/auth/world/rp-signature). The signing key never reaches the client. */
export type WorldRpContext = { rp_id: string; nonce: string; created_at: number; expires_at: number; signature: string };

/** /auth/world/verify. `created: false` = this human already has an account (no new starter credits). */
export type LoginResult = { token: string; me: Me; created: boolean };

export type ModelOffer = { model: ModelEntry; served: boolean };

export type NetworkSnapshot = { pools: PoolListing[]; nodes: NodeListing[]; stats: AccountStats[]; updated_at: number };

export type NodeLink = { node_id: string; sig: string; gpu?: string; mem_gb?: number; payout_address: `0x${string}` };

export type MirrorResult = { found: boolean; consensus_ts?: string; message?: string };

export interface PoolApi {
  readonly mode: "mock" | "live";

  auth: {
    /** Signed RP context for an IDKit request. `null` = no RP configured (demo: simulate instead). */
    rpContext(): Promise<WorldRpContext | null>;
    /** Sends the IDKit result to the gateway without changes. */
    verify(result: unknown): Promise<LoginResult>;
  };
  me(token: string): Promise<Me>;
  /** POST /nodes/register: link a node key to the account (max 3 per account). */
  registerNode(token: string, link: NodeLink): Promise<Me>;

  /** GET /v1/models + Arkiv gpupool.model: every known model and whether a live pool serves it now. */
  models(): Promise<ModelOffer[]>;
  /** Credits with a session token. Without one the gateway answers 402 (x402). */
  chat(body: ChatBody, token: string | null, signal: AbortSignal): AsyncIterable<ChatChunk>;
  request(id: string): Promise<Receipt | null>;
  /** The account's recent receipts (for /account). */
  myRequests(token: string): Promise<Receipt[]>;

  network(): Promise<NetworkSnapshot>;
  /** Live pool updates (gateway poll, or the mock ticker). Returns unsubscribe. */
  subscribe(cb: (s: NetworkSnapshot) => void): () => void;

  /** GET /ledger/events, newest first. */
  ledger(opts?: { type?: LedgerType; limit?: number }): Promise<LedgerEvent[]>;
  /** Hedera mirror node: check that an HCS message exists. */
  mirror(topic: string, seq: number): Promise<MirrorResult>;

  /** GET /payouts/:address: all epochs and this address's Merkle leaves. */
  payouts(address: string): Promise<{ epochs: Epoch[]; payouts: Payout[] }>;
  /** Demo only. In live mode the claim is a wallet transaction (EpochPayout.claim). */
  claim(payout: Payout): Promise<{ tx: string }>;
}

export class NotImplementedError extends Error {
  constructor(what: string) {
    super(`${what} is not available from the live backend yet`);
    this.name = "NotImplementedError";
  }
}

/** HTTP 402 from the gateway: no session and no x402 payment. */
export class PaymentRequired extends Error {
  constructor() {
    super("Log in with World ID to use credits. AI agents pay per request with x402.");
    this.name = "PaymentRequired";
  }
}

/** HTTP 401 / unknown token: the session is gone, log in again. */
export class SessionExpired extends Error {
  constructor() {
    super("Your session expired. Log in again.");
    this.name = "SessionExpired";
  }
}
