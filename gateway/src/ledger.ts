import type { CreditSplit, GpupoolConfig, ModelConfig, Route } from "@gpupool/shared";
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
 * cost_mc = floor(model_factor × (output_tokens + input_token_weight × input_tokens) × 1000).
 * Integer form: floor(factor_milli × (out × 10000 + in × weight_bps) / 10000).
 */
export function costMc(cfg: GpupoolConfig, model: ModelConfig, inTokens: number, outTokens: number): number {
  return Math.floor((factorMilli(model) * (outTokens * BPS + inTokens * weightBps(cfg))) / BPS);
}

/** Input tokens before the request runs: ceil(total characters of all message contents / 4). */
export function estimateInputTokens(messages: { content: string }[]): number {
  return Math.ceil(messages.reduce((n, m) => n + m.content.length, 0) / 4);
}

/** Hold (SPEC §5.3 step 4) = the cost formula with max_tokens output and the estimated input. */
export function holdMc(cfg: GpupoolConfig, model: ModelConfig, maxTokens: number, estInputTokens: number): number {
  return costMc(cfg, model, estInputTokens, maxTokens);
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
    const raw = costMc(cfg, s.model, s.inTokens, s.outTokens);
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
    const credit = db.prepare("UPDATE balances SET earned_mc = earned_mc + @mc, earned_total_mc = earned_total_mc + @mc WHERE account_id = @id");
    for (const [nodeId, mc] of Object.entries(split.nodes)) {
      const acc = ownerOf(nodeId);
      if (mc > 0 && acc) credit.run({ mc, id: acc });
    }

    db.prepare(
      `UPDATE requests SET status = 'ok', in_tokens = ?, out_tokens = ?, cost_mc = ?, split = ?, resp_hash = ? WHERE req_id = ?`,
    ).run(s.inTokens, s.outTokens, cost, JSON.stringify(split), s.respHash, s.reqId);
    recordEvent(db, signer, {
      type: "request_settled",
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
      recordEvent(db, signer, { type: "credits_expired", account_id: r.account_id, amount_mc: r.starter_mc }, now);
    }
    return rows.length;
  })();
}
