import type { Hex } from "viem";
import { keccak256, toBytes } from "viem";
import type { Db } from "./db.ts";
import { recordEvent, type Signer } from "./events.ts";
import { payoutTree, ZERO_ROOT } from "./merkle.ts";

/**
 * SPEC §16.4 disputes (EpochPayoutV2). A watcher challenges an epoch inside its window; the owner then
 * resolves it with a corrected payout tree (fraudulent providers removed). The difference goes to the
 * treasury on-chain. These functions compute the corrected tree from the gateway's frozen payouts and
 * store the result; `scripts/dispute.ts` sends the transaction.
 */

export type Resolution = {
  epoch: number; oldRoot: Hex; oldTotal: bigint;
  newRoot: Hex; newTotal: bigint; refunded: bigint;
  tree: ReturnType<typeof payoutTree>; excluded: Hex[];
};

export const evidenceHash = (evidenceId: string): Hex => keccak256(toBytes(evidenceId));

type EpochRow = { epoch: number; merkle_root: Hex; total_tinybar: string; status: string };

/** Corrected tree without the `exclude` payout addresses. Throws if an address is not in the epoch. */
export function planResolution(db: Db, epoch: number, exclude: string[]): Resolution {
  const e = db.prepare("SELECT epoch, merkle_root, total_tinybar, status FROM epochs WHERE epoch = ?").get(epoch) as EpochRow | undefined;
  if (!e) throw new Error(`no epoch ${epoch}`);
  const rows = db.prepare("SELECT payout_address, amount_tinybar FROM epoch_payouts WHERE epoch = ? ORDER BY payout_address").all(epoch) as { payout_address: Hex; amount_tinybar: string }[];
  const drop = new Set(exclude.map((a) => a.toLowerCase()));
  for (const a of drop) if (!rows.some((r) => r.payout_address === a)) throw new Error(`${a} has no payout in epoch ${epoch}`);
  const keep = rows.filter((r) => !drop.has(r.payout_address));
  const tree = payoutTree(epoch, keep);
  const newTotal = keep.reduce((s, r) => s + BigInt(r.amount_tinybar), 0n);
  const oldTotal = BigInt(e.total_tinybar);
  return { epoch, oldRoot: e.merkle_root, oldTotal, newRoot: newTotal === 0n ? ZERO_ROOT : tree.root, newTotal, refunded: oldTotal - newTotal, tree, excluded: [...drop] as Hex[] };
}

/** After the on-chain `resolve`: store the corrected payouts and proofs, and record the clawback on HCS. */
export function applyResolution(db: Db, signer: Signer, plan: Resolution, evidenceId: string, now = Date.now()): void {
  db.transaction(() => {
    db.prepare("UPDATE epochs SET merkle_root = ?, total_tinybar = ?, status = ? WHERE epoch = ?")
      .run(plan.newRoot, plan.newTotal.toString(), plan.newTotal === 0n ? "voided" : "posted", plan.epoch);
    db.prepare("DELETE FROM epoch_payouts WHERE epoch = ?").run(plan.epoch);
    for (const p of plan.tree.proofs) {
      db.prepare("INSERT INTO epoch_payouts (epoch, payout_address, amount_tinybar, proof) VALUES (?, ?, ?, ?)").run(plan.epoch, p.payout_address, p.amount_tinybar, JSON.stringify(p.proof));
    }
    recordEvent(db, signer, {
      type: "epoch_resolved", epoch: plan.epoch, old_root: plan.oldRoot, new_root: plan.newTotal === 0n ? null : plan.newRoot,
      new_total_tinybar: plan.newTotal.toString(), refunded_tinybar: plan.refunded.toString(), evidence_id: evidenceId,
    }, now);
  })();
}
