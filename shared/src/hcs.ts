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
  Millicredits,
  ModelId,
  RequestId,
  Route,
  Tinybar,
  TimestampMs,
} from "./common.ts";

/**
 * HCS ledger events (SPEC §8.6, §10.2). One message per event, < 1 KB.
 * `sig` = ed25519 signature (GATEWAY_SIGNING_KEY) over the canonical JSON of the event
 * without `sig`: keys sorted recursively, no whitespace, UTF-8.
 * The same JSON (with sig) is stored in `ledger_events.payload`.
 */

const base = {
  v: z.literal(1),
  ts: TimestampMs,
  sig: HexSig,
};

export const AccountCreatedEvent = z.object({
  ...base,
  type: z.literal("account_created"),
  account_id: AccountId,
});

export const StarterGrantEvent = z.object({
  ...base,
  type: z.literal("starter_grant"),
  account_id: AccountId,
  amount_mc: Millicredits,
  expires_at: TimestampMs,
});

/** A credit-paid request was settled. Failed requests cost nothing and write no event. */
export const RequestSettledEvent = z.object({
  ...base,
  type: z.literal("request_settled"),
  req_id: RequestId,
  account_id: AccountId,
  model: ModelId,
  in_tokens: z.number().int().nonnegative(),
  out_tokens: z.number().int().nonnegative(),
  cost_mc: Millicredits,
  split: CreditSplit,
  pay: z.literal("credits"),
  prompt_hash: Hex32,
  resp_hash: Hex32,
});

/** An x402-paid request was served. Providers are paid in HBAR at epoch close, from `route`. */
export const X402PaymentEvent = z.object({
  ...base,
  type: z.literal("x402_payment"),
  req_id: RequestId,
  payer: HederaAccountId,
  tx_id: HederaTxId,
  amount_tinybar: Tinybar,
  model: ModelId,
  in_tokens: z.number().int().nonnegative(),
  out_tokens: z.number().int().nonnegative(),
  /** Null = route unknown (SPEC §5.5); the provider share of this request stays in the treasury. */
  route: Route.nullable(),
  pay: z.literal("x402"),
  prompt_hash: Hex32,
  resp_hash: Hex32,
});

export const CreditsExpiredEvent = z.object({
  ...base,
  type: z.literal("credits_expired"),
  account_id: AccountId,
  amount_mc: Millicredits,
});

export const PayoutAddressSetEvent = z.object({
  ...base,
  type: z.literal("payout_address_set"),
  account_id: AccountId,
  payout_address: EvmAddress,
});

export const EpochClosedEvent = z.object({
  ...base,
  type: z.literal("epoch_closed"),
  epoch: EpochNumber,
  start_ts: TimestampMs,
  end_ts: TimestampMs,
  total_tinybar: Tinybar,
  merkle_root: Hex32,
  /** keccak256 of the canonical JSON of the full payout list. */
  payouts_hash: Hex32,
  /** Full list if the message stays < 1 KB; otherwise null and the gateway keeps it. */
  payouts: z.array(z.object({ payout_address: EvmAddress, amount_tinybar: Tinybar })).nullable(),
});

export const PayoutClaimedEvent = z.object({
  ...base,
  type: z.literal("payout_claimed"),
  epoch: EpochNumber,
  payout_address: EvmAddress,
  amount_tinybar: Tinybar,
  /** EVM transaction hash of the `claim` call. */
  claim_tx: Hex32,
});

export const LedgerEvent = z.discriminatedUnion("type", [
  AccountCreatedEvent,
  StarterGrantEvent,
  RequestSettledEvent,
  X402PaymentEvent,
  CreditsExpiredEvent,
  PayoutAddressSetEvent,
  EpochClosedEvent,
  PayoutClaimedEvent,
]);
export type LedgerEvent = z.infer<typeof LedgerEvent>;
export type LedgerEventType = LedgerEvent["type"];
export const LEDGER_EVENT_TYPES = LedgerEvent.options.map((o) => o.shape.type.value);
