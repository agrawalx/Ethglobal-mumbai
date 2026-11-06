import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { Hex } from "viem";
import { LedgerEvent } from "@gpupool/shared";
import { openDb, type Db } from "../src/db.ts";
import { loadConfig } from "../src/config.ts";
import { ZERO_ROOT } from "../src/merkle.ts";
import { createSettlement, payoutsFor, type BundleStore, type Dispute, type EpochState } from "../src/settlement.ts";
import { beeStore, checkBundle, fetchBundle } from "../src/swarm.ts";
import { legalGate } from "../src/legal.ts";
import { FakeChain } from "./fake-settlement.ts";
import { signer } from "./helpers.ts";

/** SPEC §16.4: EpochPayoutV2 settlement, namespaces, Swarm bundles, disputes, scheduled sweeps. */
const A = `0x${"b1".repeat(20)}` as Hex;
const B = `0x${"b2".repeat(20)}` as Hex;
const NOW = 1_200_000;
const base = { DATABASE_PATH: ":memory:", POOL_COORDINATOR_URL: "http://127.0.0.1:3001", EPOCH_SECONDS: "600" };
const snap = (address: Hex, start: number, end: number, node: string) => ({ node_id: `0x${node.repeat(40)}`, owner_account: "acc_p", payout_address: address, layers: [start, end] });
const hcsConfirmed = (db: Db) => db.prepare("UPDATE ledger_events SET hcs_seq = 100 + id WHERE hcs_seq IS NULL").run();

function seed(db: Db, id: string, tx: string, ts = 610_000) {
  db.prepare(`INSERT INTO requests (req_id, model, status, pay_type, x402_payer, x402_tx, x402_amount_tinybar, payout_snapshot, prompt_hash, resp_hash, ts)
    VALUES (?, 'Qwen/Qwen3-14B-FP8', 'ok', 'x402', '0.0.9', ?, '2000000', ?, ?, ?, ?)`)
    .run(id, tx, JSON.stringify([snap(A, 0, 20, "1"), snap(B, 20, 40, "2")]), `0x${"11".repeat(32)}`, `0x${"22".repeat(32)}`, ts);
}

class FakeChainV2 extends FakeChain {
  posts2: { epoch: number; hcsSeq?: number; unlockAt?: number }[] = [];
  disputeEvents: { epoch: number; block: bigint; event: Dispute }[] = [];
  scheduled: { epoch: number; at: number }[] = [];
  failSchedule = false;
  window = 3600n;
  preparePost = async (epoch: number, root: Hex, amount: bigint, hcsSeq?: number, unlockAt?: number) => {
    this.posts2.push({ epoch, hcsSeq, unlockAt });
    return this.make("post", amount, epoch, root);
  };
  epoch = async (e: number): Promise<EpochState> => {
    const s = this.states.get(e);
    if (!s) return { root: ZERO_ROOT, total: 0n, claimed: 0n, postedAt: 0n };
    return { ...s, opensAt: s.postedAt + this.window + 500n, sweepAt: s.postedAt + 7n * 86_400n, state: "open" };
  };
  disputes = async (epoch: number, from: bigint, to: bigint) => this.disputeEvents.filter((d) => d.epoch === epoch && d.block >= from && d.block <= to).map((d) => d.event);
  scheduleSweep = async (epoch: number, at: number) => {
    if (this.failSchedule) throw new Error("schedule unavailable");
    this.scheduled.push({ epoch, at });
    return `0.0.7000${this.scheduled.length}`;
  };
}

async function posted(extra: Record<string, string> = {}, store?: BundleStore) {
  const cfg = loadConfig({ ...base, ...extra });
  const db = openDb(":memory:");
  const chain = new FakeChainV2();
  const job = createSettlement(db, cfg, signer, chain, store);
  seed(db, "req_a", "0.0.9@1.1");
  await job.runOnce(NOW); hcsConfirmed(db); await job.runOnce(NOW); await job.runOnce(NOW);
  return { cfg, db, chain, job };
}

test("V2 post: carries the HCS sequence of epoch_closed and the vesting unlock; claimable_at = contract opensAt", async () => {
  const { db, chain } = await posted({ PAYOUT_VESTING_SECONDS: "86400" });
  const e = db.prepare("SELECT * FROM epochs").get() as { epoch: number; status: string; claimable_at: number; hcs_event_id: number };
  const seq = (db.prepare("SELECT hcs_seq FROM ledger_events WHERE id = ?").get(e.hcs_event_id) as { hcs_seq: number }).hcs_seq;
  assert.equal(e.status, "posted");
  assert.equal(chain.posts2[0]!.hcsSeq, seq, "the contract can compare its post with the audit message");
  assert.ok(chain.posts2[0]!.unlockAt! > Date.now() / 1000 + 86_000, "vesting unlock is set");
  assert.equal(e.claimable_at, Number(1200n + 3600n + 500n) * 1000, "claims open at the contract's opensAt (window and vesting)");
  db.close();
});

test("gateway namespaces: GATEWAY_INDEX × 2^32 + n is the contract epoch; the epoch_closed event and proofs use it", async () => {
  const { db, chain } = await posted({ GATEWAY_INDEX: "3" });
  const e = db.prepare("SELECT epoch, start_ts FROM epochs").get() as { epoch: number; start_ts: number };
  assert.equal(e.epoch, 3 * 2 ** 32 + 1, "epoch 1 of gateway 3");
  assert.equal(e.start_ts, 600_000, "time window is still epoch n");
  assert.equal(Math.floor(e.epoch / 2 ** 32), 3);
  assert.equal(chain.posts2[0]!.epoch, e.epoch);
  const ev = LedgerEvent.parse(JSON.parse((db.prepare("SELECT payload FROM ledger_events WHERE type = 'epoch_closed'").get() as { payload: string }).payload));
  assert.ok(ev.type === "epoch_closed" && ev.epoch === e.epoch);
  assert.equal(payoutsFor(db, A, 10 ** 15).payouts[0]!.epoch, e.epoch);
  db.close();
});

test("Swarm bundle: uploaded before the epoch closes; reference is in the signed HCS event; the bundle rebuilds the Merkle root", async () => {
  const uploads: { name: string; json: string }[] = [];
  const store: BundleStore = { upload: async (name, json) => { uploads.push({ name, json }); return "ab".repeat(32); } };
  const { db } = await posted({}, store);
  const e = db.prepare("SELECT epoch, merkle_root, swarm_ref FROM epochs").get() as { epoch: number; merkle_root: string; swarm_ref: string };
  assert.equal(e.swarm_ref, "ab".repeat(32));
  const ev = LedgerEvent.parse(JSON.parse((db.prepare("SELECT payload FROM ledger_events WHERE type = 'epoch_closed'").get() as { payload: string }).payload));
  assert.ok(ev.type === "epoch_closed" && ev.swarm_ref === "ab".repeat(32));
  assert.equal(uploads.length, 1);
  assert.equal(uploads[0]!.name, `epoch-${e.epoch}.json`);
  const bundle = JSON.parse(uploads[0]!.json) as { receipts: { req_id: string; prompt_hash: string; payout_snapshot: unknown[] }[]; payouts: unknown[]; gateway_pubkey: string };
  assert.equal(bundle.receipts[0]!.req_id, "req_a");
  assert.ok(Array.isArray(bundle.receipts[0]!.payout_snapshot));
  assert.ok(!uploads[0]!.json.includes("transcript") && !uploads[0]!.json.includes('"prompt"'), "never prompts");
  assert.equal(bundle.gateway_pubkey, signer.publicKeyHex);
  const check = checkBundle(bundle, e.merkle_root);
  assert.deepEqual(check.problems, []);
  assert.ok(check.ok);
  // A tampered bundle is detected.
  const bad = JSON.parse(uploads[0]!.json) as { payouts: { amount_tinybar: string }[] };
  bad.payouts[0]!.amount_tinybar = "999999999";
  assert.ok(!checkBundle(bad, e.merkle_root).ok);
  db.close();
});

test("Swarm outage delays the close (no epoch without its bundle); the next tick closes it", async () => {
  let fail = true;
  const store: BundleStore = { upload: async () => { if (fail) throw new Error("Bee unreachable"); return "cd".repeat(32); } };
  const cfg = loadConfig(base);
  const db = openDb(":memory:");
  const job = createSettlement(db, cfg, signer, new FakeChainV2(), store);
  seed(db, "req_a", "0.0.9@1.1");
  await job.closeDue(NOW);
  assert.equal((db.prepare("SELECT count(*) AS n FROM epochs").get() as { n: number }).n, 0);
  assert.equal((db.prepare("SELECT count(*) AS n FROM ledger_events WHERE type = 'epoch_closed'").get() as { n: number }).n, 0);
  fail = false;
  await job.closeDue(NOW);
  assert.equal((db.prepare("SELECT swarm_ref FROM epochs").get() as { swarm_ref: string }).swarm_ref, "cd".repeat(32));
  db.close();
});

test("Bee client: POST /bzz with the postage batch header; GET /bzz/<ref>; bad answers are errors", async () => {
  const seen: { method: string; url: string; batch: string | undefined; body: string }[] = [];
  const bee = createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      seen.push({ method: req.method!, url: req.url!, batch: req.headers["swarm-postage-batch-id"] as string | undefined, body });
      res.setHeader("content-type", "application/json");
      if (req.method === "POST") return res.writeHead(201).end(JSON.stringify({ reference: "ef".repeat(32) }));
      res.end(JSON.stringify({ hello: "bundle" }));
    });
  });
  await new Promise<void>((r) => bee.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(bee.address() as AddressInfo).port}`;
  const batch = "12".repeat(32);
  const store = beeStore({ apiUrl: url, batchId: batch });
  assert.equal(await store.upload("epoch-1.json", '{"a":1}'), "ef".repeat(32));
  assert.deepEqual(seen[0], { method: "POST", url: "/bzz?name=epoch-1.json", batch, body: '{"a":1}' });
  assert.deepEqual(await fetchBundle(url, "ef".repeat(32)), { hello: "bundle" });
  assert.equal(seen[1]!.url, `/bzz/${"ef".repeat(32)}`);
  await assert.rejects(fetchBundle(url, "nothex"), /64 lowercase hex/);
  assert.throws(() => beeStore({ apiUrl: url, batchId: "short" }), /64-hex/);
  bee.close();
  const down = beeStore({ apiUrl: url, batchId: batch });
  await assert.rejects(down.upload("x", "{}"));
});

test("disputes: challenged hides the proofs, dismissed restores them, resolved matches the corrected local root or goes to review", async () => {
  const { db, chain, job } = await posted();
  const e = db.prepare("SELECT epoch, claims_block, merkle_root FROM epochs").get() as { epoch: number; claims_block: string; merkle_root: string };
  const at = (n: bigint) => BigInt(e.claims_block) + n;
  assert.equal(payoutsFor(db, A, 10 ** 15).payouts.length, 1);
  chain.block = at(5n);
  chain.disputeEvents.push({ epoch: e.epoch, block: at(2n), event: { type: "challenged", evidence: `0x${"ee".repeat(32)}` } });
  await job.runOnce(NOW);
  assert.equal((db.prepare("SELECT status FROM epochs").get() as { status: string }).status, "challenged");
  assert.equal(payoutsFor(db, A, 10 ** 15).payouts.length, 0, "no proofs while challenged");
  chain.disputeEvents.push({ epoch: e.epoch, block: at(8n), event: { type: "dismissed" } });
  chain.block = at(10n);
  await job.runOnce(NOW);
  assert.equal((db.prepare("SELECT status FROM epochs").get() as { status: string }).status, "posted");
  assert.equal(payoutsFor(db, A, 10 ** 15).payouts.length, 1);
  // Resolved to a root the gateway does not have → review (needs a person); proofs stay hidden.
  chain.disputeEvents.push({ epoch: e.epoch, block: at(12n), event: { type: "challenged", evidence: `0x${"ee".repeat(32)}` } });
  chain.disputeEvents.push({ epoch: e.epoch, block: at(13n), event: { type: "resolved", newRoot: `0x${"99".repeat(32)}`, newTotal: 1n } });
  chain.block = at(15n);
  await job.runOnce(NOW);
  assert.equal((db.prepare("SELECT status FROM epochs").get() as { status: string }).status, "review");
  assert.equal(payoutsFor(db, A, 10 ** 15).payouts.length, 0);
  db.close();
});

test("scheduled sweep: scheduled once per posted epoch at the contract's sweepAt; failures retry; off by default", async () => {
  const off = await posted();
  await off.job.runOnce(NOW);
  assert.equal(off.chain.scheduled.length, 0, "SCHEDULE_SWEEP is off by default");
  off.db.close();

  const { db, chain, job } = await posted({ SCHEDULE_SWEEP: "true" });
  assert.equal(chain.scheduled.length, 1);
  assert.equal(chain.scheduled[0]!.at, Number(1200n + 7n * 86_400n));
  assert.equal((db.prepare("SELECT sweep_schedule FROM epochs").get() as { sweep_schedule: string }).sweep_schedule, "0.0.70001");
  await job.runOnce(NOW);
  assert.equal(chain.scheduled.length, 1, "not scheduled twice");
  db.close();

  const retry = await (async () => {
    const cfg = loadConfig({ ...base, SCHEDULE_SWEEP: "true" });
    const d = openDb(":memory:");
    const c = new FakeChainV2();
    c.failSchedule = true;
    const j = createSettlement(d, cfg, signer, c);
    seed(d, "req_a", "0.0.9@1.1");
    await j.runOnce(NOW); hcsConfirmed(d); await j.runOnce(NOW); await j.runOnce(NOW);
    return { d, c, j };
  })();
  assert.equal((retry.d.prepare("SELECT sweep_schedule FROM epochs").get() as { sweep_schedule: string | null }).sweep_schedule, null);
  retry.c.failSchedule = false;
  await retry.j.runOnce(NOW);
  assert.equal(retry.c.scheduled.length, 1, "retried on the next tick");
  retry.d.close();
});

test("legal gate: only Hedera testnet; a counsel reference is logged but does not unlock mainnet", () => {
  const ok = loadConfig({ ...base });
  assert.doesNotThrow(() => legalGate(ok));
  assert.throws(() => legalGate(loadConfig({ ...base, HEDERA_NETWORK: "mainnet" })), /docs\/LEGAL_CHECK\.md/);
  assert.throws(() => legalGate(loadConfig({ ...base, HEDERA_CHAIN_ID: "295" })), /testnet only/);
  assert.throws(() => legalGate(loadConfig({ ...base, HEDERA_NETWORK: "mainnet", LEGAL_CLEARANCE_REF: "opinion-2026-12" })), /blocked/);
});

// ---------- disputes: corrected tree, clawback record ----------

import { applyResolution, evidenceHash, planResolution } from "../src/dispute.ts";
import { verifyPayoutProof } from "../src/merkle.ts";

test("resolve plan: provider removed, new root/total/refund; applying stores proofs that verify and records epoch_resolved", async () => {
  const { db } = await posted();
  const e = db.prepare("SELECT epoch, merkle_root, total_tinybar FROM epochs").get() as { epoch: number; merkle_root: Hex; total_tinybar: string };
  const rows = db.prepare("SELECT payout_address, amount_tinybar FROM epoch_payouts ORDER BY payout_address").all() as { payout_address: Hex; amount_tinybar: string }[];
  assert.equal(rows.length, 2);
  const plan = planResolution(db, e.epoch, [B]);
  assert.equal(plan.oldRoot, e.merkle_root);
  assert.equal(plan.refunded, BigInt(rows[1]!.amount_tinybar), "B's payout goes back to the treasury");
  assert.equal(plan.newTotal + plan.refunded, BigInt(e.total_tinybar));
  assert.notEqual(plan.newRoot, e.merkle_root);
  assert.throws(() => planResolution(db, e.epoch, [`0x${"ff".repeat(20)}`]), /no payout/);
  assert.equal(evidenceHash("ver_1"), evidenceHash("ver_1"));
  applyResolution(db, signer, plan, "ver_1");
  const stored = db.prepare("SELECT payout_address, amount_tinybar, proof FROM epoch_payouts").all() as { payout_address: Hex; amount_tinybar: string; proof: string }[];
  assert.deepEqual(stored.map((s) => s.payout_address), [A]);
  assert.ok(verifyPayoutProof(A, BigInt(stored[0]!.amount_tinybar), JSON.parse(stored[0]!.proof), plan.newRoot));
  assert.deepEqual(db.prepare("SELECT merkle_root, status FROM epochs").get(), { merkle_root: plan.newRoot, status: "posted" });
  const ev = LedgerEvent.parse(JSON.parse((db.prepare("SELECT payload FROM ledger_events WHERE type = 'epoch_resolved'").get() as { payload: string }).payload));
  assert.ok(ev.type === "epoch_resolved" && ev.refunded_tinybar === plan.refunded.toString() && ev.evidence_id === "ver_1" && ev.old_root === e.merkle_root);
  // Excluding everyone voids the epoch.
  const { db: db2 } = await posted();
  const e2 = db2.prepare("SELECT epoch FROM epochs").get() as { epoch: number };
  const all = planResolution(db2, e2.epoch, [A, B]);
  assert.equal(all.newRoot, ZERO_ROOT);
  applyResolution(db2, signer, all, "ver_2");
  assert.equal((db2.prepare("SELECT status FROM epochs").get() as { status: string }).status, "voided");
  assert.equal(payoutsFor(db2, A, 10 ** 15).payouts.length, 0);
  db.close(); db2.close();
});
