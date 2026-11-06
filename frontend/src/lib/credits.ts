/* Credit and price rules from spec v0.1 §7.3 and §8. Pure functions: the gateway
   is the source of truth; the frontend uses these for estimates, the mock and tests. */
import type { Balance, PriceTier, RouteHop, Split } from "@shared/types";

export const STARTER_CREDITS = 10_000;
export const STARTER_TTL_MS = 14 * 24 * 3600_000;
export const IN_WEIGHT = 0.2;
export const SHARE = { nodes: 0.9, burn: 0.05, reserve: 0.05 } as const;
export const MAX_NODES_PER_ACCOUNT = 3;

/** §8.1 cost = model_factor × (output_tokens + 0.2 × input_tokens) */
export function cost(factor: number, inTokens: number, outTokens: number) {
  return factor * (outTokens + IN_WEIGHT * inTokens);
}

/** Rough prompt size (≈4 characters a token). Only for the hold estimate; the gateway counts the real tokens. */
export function estimateTokens(messages: { content: string }[]) {
  return Math.ceil(messages.reduce((n, m) => n + m.content.length + 4, 0) / 4);
}

/** §5.3 step 4: the gateway holds the maximum cost before it forwards the request. */
export function holdFor(factor: number, maxTokens: number, inTokens: number) {
  return cost(factor, inTokens, maxTokens);
}

/** §8.3: 90% to the route by layers served, 5% burn, 5% reserve.
    §8.4 self-request rule: a node owned by the requester gets 0, and its share goes to the reserve. */
export function split(total: number, route: RouteHop[], requester: string | null, ownerOf: (nodeId: string) => string | undefined): Split {
  const layers = route.reduce((s, h) => s + (h.layers[1] - h.layers[0]), 0);
  let reserve = total * SHARE.reserve;
  const nodes = route.map((h) => {
    const n = h.layers[1] - h.layers[0];
    const share = layers > 0 ? (total * SHARE.nodes * n) / layers : 0;
    const self = requester != null && ownerOf(h.node_id) === requester;
    if (self) reserve += share;
    return { node_id: h.node_id, layers: n, credits: self ? 0 : share, self };
  });
  return { nodes, burn: total * SHARE.burn, reserve };
}

/** Starter credits count only until they expire. */
export function liveStarter(b: Balance, now = Date.now()) {
  return b.starter_expires_at > now ? b.starter : 0;
}

/** Credits the account can still hold for a new request. */
export function available(b: Balance, now = Date.now()) {
  return liveStarter(b, now) + b.earned - b.held;
}

export class InsufficientCredits extends Error {
  readonly needed: number;
  readonly have: number;
  constructor(needed: number, have: number) {
    super(`Not enough credits for this request (needs ~${Math.ceil(needed).toLocaleString("en-US")}, you have ${Math.floor(have).toLocaleString("en-US")}).`);
    this.name = "InsufficientCredits";
    this.needed = needed;
    this.have = have;
  }
}

/** §8.2 spending order: starter credits first, then earned credits. Returns the new balance. */
export function spend(b: Balance, amount: number, now = Date.now()): Balance {
  const starter = liveStarter(b, now);
  if (amount > starter + b.earned + 1e-9) throw new InsufficientCredits(amount, starter + b.earned);
  const fromStarter = Math.min(starter, amount);
  return {
    ...b,
    starter: b.starter - fromStarter,
    earned: b.earned - (amount - fromStarter),
    spent_total: b.spent_total + amount,
  };
}

/** §8.2 contribution ratio = earned_total / max(spent_total, 1) */
export function ratio(earnedTotal: number, spentTotal: number) {
  return earnedTotal / Math.max(spentTotal, 1);
}

/** §7.3 x402 prices (HBAR on testnet). */
export const PRICES: PriceTier[] = [
  { max_params_b: 8, tier512: "0.01", tier2048: "0.03", asset: "HBAR" },
  { max_params_b: 14, tier512: "0.02", tier2048: "0.06", asset: "HBAR" },
];

/** x402 price in HBAR for a model size and max_tokens. Larger models use the 14B row. */
export function x402Price(paramsB: number, maxTokens: number) {
  const tier = PRICES.find((p) => paramsB <= p.max_params_b) ?? PRICES[PRICES.length - 1];
  return Number(maxTokens <= 512 ? tier.tier512 : tier.tier2048);
}
