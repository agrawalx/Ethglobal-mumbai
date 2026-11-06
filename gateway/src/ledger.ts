import { addReserve, consumeEarned, creditEarned } from "./incentives.ts";
import { contentText, type ChatMessage, type CreditSplit, type GpupoolConfig, type ModelConfig, type Route, type Tool } from "@gpupool/shared";
import type { Db } from "./db.ts";
import { recordEvent, type Signer } from "./events.ts";

/**
 * Credit ledger (SPEC §8). All amounts are integer millicredits (mc, 1 credit = 1000 mc).
 * Every balance change runs in one SQLite transaction together with its ledger event.
 */

const BPS = 10_000;

/** model_factor in milli-units, so cost math is integer. 1.75 → 1750. */
const factorMilli = (m: ModelConfig): number => Math.round(m.model_factor * 1000);
const weightBps = (cfg: GpupoolConfig): number => Math.round(cfg.cost.input_token_weight * BPS);

/**
 * cost_mc = floor(model_factor × locked_multiplier × (out + input_token_weight × in) × 1000).
 * BigInt intermediates retain exact integer rounding for both holds and settlement.
 */
export function costMc(cfg: GpupoolConfig, model: ModelConfig, inTokens: number, outTokens: number, multiplier = 1): number {
  if (!Number.isFinite(multiplier) || multiplier < 0.5 || multiplier > 2) throw new Error("invalid price multiplier");
  const priceBps = Math.round(multiplier * BPS);
  return Number(BigInt(factorMilli(model)) * (BigInt(outTokens) * BigInt(BPS) + BigInt(inTokens) * BigInt(weightBps(cfg))) * BigInt(priceBps) / BigInt(BPS * BPS));
}

/** Characters a message adds to the prompt: its text, plus tool-call names and arguments. */
const messageChars = (m: ChatMessage): number =>
  contentText(m.content).length +
  (m.role === "assistant" ? (m.tool_calls ?? []).reduce((n, t) => n + t.function.name.length + t.function.arguments.length, 0) : 0);

/**
 * Input tokens before the request runs: ceil(characters / 4) over all message text, tool calls and
 * the tool definitions (they are part of the prompt the model reads).
 */
export function estimateInputTokens(messages: ChatMessage[], tools: Tool[] = []): number {
  const chars = messages.reduce((n, m) => n + messageChars(m), 0) + (tools.length ? JSON.stringify(tools).length : 0);
  return Math.ceil(chars / 4);
}

/** Hold (SPEC §5.3 step 4) = the cost formula with max_tokens output and the estimated input. */
export function holdMc(cfg: GpupoolConfig, model: ModelConfig, maxTokens: number, estInputTokens: number, multiplier = 1): number {
  return costMc(cfg, model, estInputTokens, maxTokens, multiplier);
}

/**
 * Who gets a share of a node's part. THE self-request rule (SPEC §8.3/§8.4, confirmed): a node
 * owned by the requesting account gets 0; its share goes to the network reserve.
 */
export const paysNode = (nodeOwner: string | null, requester: string | null): boolean => nodeOwner !== requester;

/**
 * Split of one credit request (SPEC §8.3, shared/README.md "Units"):
 *   nodes_share = floor(cost × 90%); each node floor(nodes_share × layers / total_layers);
 *   burn = floor(cost × 5%); reserve = cost − Σnodes − burn (takes every rounding remainder).
 * route null (unknown) → no node gets credits; the whole nodes share goes to reserve.
 */
export function splitCost(
  cfg: GpupoolConfig,
  cost: number,
  route: Route | null,
  totalLayers: number,
  ownerOf: (nodeId: string) => string | null,
  requester: string | null,
): CreditSplit {
  const nodesShare = Math.floor((cost * cfg.credit_split_bps.nodes) / BPS);
  const burn = Math.floor((cost * cfg.credit_split_bps.burn) / BPS);
  const nodes: Record<string, number> = {};
  for (const hop of route ?? []) {
    const layers = hop.layers[1] - hop.layers[0];
    const share = Math.floor((nodesShare * layers) / totalLayers);
    nodes[hop.node_id] = (nodes[hop.node_id] ?? 0) + (paysNode(ownerOf(hop.node_id), requester) ? share : 0);
  }
  const paid = Object.values(nodes).reduce((a, b) => a + b, 0);
  return { nodes, burn_mc: burn, reserve_mc: cost - paid - burn };
}

type BalanceRow = { starter_mc: number; starter_expires_at: number | null; earned_mc: number; held_mc: number };

const starterValid = (b: BalanceRow, now: number): number => (b.starter_expires_at !== null && b.starter_expires_at > now ? b.starter_mc : 0);

/** Spendable now = valid starter + earned − held. */
export function availableMc(db: Db, accountId: string, now = Date.now()): number {
  const b = db.prepare("SELECT starter_mc, starter_expires_at, earned_mc, held_mc FROM balances WHERE account_id = ?").get(accountId) as BalanceRow | undefined;
  if (!b) return 0;
  return starterValid(b, now) + b.earned_mc - b.held_mc;
}

/**
 * Hold `amount` for a request. One conditional UPDATE, so two concurrent requests cannot both
 * pass the check (better-sqlite3 is synchronous; the statement is atomic). false = not enough.
 */
export function tryHold(db: Db, accountId: string, amount: number, now = Date.now()): boolean {
  const r = db
    .prepare(
      `UPDATE balances SET held_mc = held_mc + @amount
       WHERE account_id = @id
         AND (CASE WHEN starter_expires_at > @now THEN starter_mc ELSE 0 END) + earned_mc - held_mc >= @amount`,
    )
    .run({ id: accountId, amount, now });
  return r.changes === 1;
}

/** Give a hold back (failed request). */
export function releaseHold(db: Db, accountId: string, amount: number): void {
  db.prepare("UPDATE balances SET held_mc = MAX(held_mc - ?, 0) WHERE account_id = ?").run(amount, accountId);
}

export type SettleInput = {
  reqId: string;
  accountId: string;
  model: ModelConfig;
  hold: number;
  inTokens: number;
  outTokens: number;
  route: Route | null;
  promptHash: string;
  respHash: string;
  priceMultiplier?: number;
};

export type SettleResult = { cost: number; split: CreditSplit };

/**
 * Settle a successful credit request in ONE transaction:
 * - cost = costMc(usage), capped at the hold (the hold used an input estimate; we never charge
 *   more than we held) and at what the account still has (starter may expire during a request);
 * - release the hold; spend starter first (if not expired), then earned; spent_total += cost;
 * - credit each node owner's earned / earned_total with its split share;
 * - update the requests row; insert the request_settled ledger event.
 */
export function settle(db: Db, cfg: GpupoolConfig, signer: Signer, s: SettleInput, now = Date.now()): SettleResult {
  return db.transaction((): SettleResult => {
    const b = db.prepare("SELECT starter_mc, starter_expires_at, earned_mc, held_mc FROM balances WHERE account_id = ?").get(s.accountId) as BalanceRow;
    const raw = costMc(cfg, s.model, s.inTokens, s.outTokens, s.priceMultiplier ?? 1);
    const starter = starterValid(b, now);
    let cost = Math.min(raw, s.hold);
    if (cost > starter + b.earned_mc) {
      console.warn(`settle ${s.reqId}: cost ${cost} mc > balance ${starter + b.earned_mc} mc (starter expired during the request?); charging the balance`);
      cost = starter + b.earned_mc;
    }
    if (raw > s.hold) console.warn(`settle ${s.reqId}: actual cost ${raw} mc > hold ${s.hold} mc (input estimate too low); charged the hold`);
    const fromStarter = Math.min(starter, cost);
    const fromEarned = cost - fromStarter;
    db.prepare(
      `UPDATE balances SET held_mc = MAX(held_mc - @hold, 0), starter_mc = starter_mc - @fs, earned_mc = earned_mc - @fe,
         spent_total_mc = spent_total_mc + @cost WHERE account_id = @id`,
    ).run({ hold: s.hold, fs: fromStarter, fe: fromEarned, cost, id: s.accountId });

    const owner = db.prepare("SELECT account_id FROM nodes WHERE node_id = ?");
    const ownerOf = (nodeId: string) => (owner.get(nodeId) as { account_id: string } | undefined)?.account_id ?? null;
    const split = splitCost(cfg, cost, s.route, s.model.num_layers, ownerOf, s.accountId);
    // SPEC §16.3: spending from earned uses the oldest lots; each owner's share vests as a new lot;
    // the reserve share is kept for availability rewards and clawbacks.
    if (fromEarned > 0) consumeEarned(db, s.accountId, fromEarned);
    for (const [nodeId, mc] of Object.entries(split.nodes)) {
      const acc = ownerOf(nodeId);
      if (mc > 0 && acc) creditEarned(db, cfg, acc, mc, "request", s.reqId, now);
    }
    addReserve(db, split.reserve_mc);

    db.prepare(
      `UPDATE requests SET status = 'ok', in_tokens = ?, out_tokens = ?, cost_mc = ?, split = ?, resp_hash = ? WHERE req_id = ?`,
    ).run(s.inTokens, s.outTokens, cost, JSON.stringify(split), s.respHash, s.reqId);
    recordEvent(db, signer, {
      type: "request_settled",
      price_multiplier: s.priceMultiplier ?? 1,
      req_id: s.reqId,
      account_id: s.accountId,
      model: s.model.model_id,
      in_tokens: s.inTokens,
      out_tokens: s.outTokens,
      cost_mc: cost,
      split,
      pay: "credits",
      prompt_hash: s.promptHash as `0x${string}`,
      resp_hash: s.respHash as `0x${string}`,
    }, now);
    return { cost, split };
  })();
}

/**
 * Starter credit expiry (SPEC §8.2): every account whose starter credits expired gets
 * starter_mc = 0 and a credits_expired event. Returns the number of accounts expired.
 */
export function expireStarterCredits(db: Db, signer: Signer, now = Date.now()): number {
  return db.transaction(() => {
    const rows = db.prepare("SELECT account_id, starter_mc FROM balances WHERE starter_mc > 0 AND starter_expires_at <= ?").all(now) as { account_id: string; starter_mc: number }[];
    const zero = db.prepare("UPDATE balances SET starter_mc = 0 WHERE account_id = ?");
    for (const r of rows) {
      zero.run(r.account_id);
      recordEvent(db, signer, { type: "credits_expired", account_id: r.account_id as `acc_${string}`, amount_mc: r.starter_mc, kind: "starter" }, now);
    }
    return rows.length;
  })();
}
