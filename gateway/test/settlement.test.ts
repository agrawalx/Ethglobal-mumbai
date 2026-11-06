import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { keccak256, toHex, type Hex } from "viem";
import { canonicalJson, LedgerEvent, PayoutsResponse } from "@gpupool/shared";
import { openDb } from "../src/db.ts";
import { loadConfig } from "../src/config.ts";
import { createApp } from "../src/app.ts";
import { payoutLeaf, payoutTree, verifyPayoutProof, ZERO_ROOT } from "../src/merkle.ts";
import { tinybarsToWeibars } from "../src/payout-chain.ts";
import { createSettlement, payoutsFor, providerPayouts, type PaidRequest } from "../src/settlement.ts";
import { signer } from "./helpers.ts";

const A = `0x${"b1".repeat(20)}` as Hex;
const B = `0x${"b2".repeat(20)}` as Hex;
const PAYER = `0x${"c1".repeat(20)}` as Hex;
const NOW = 1_200_000;
const cfg = loadConfig({ DATABASE_PATH: ":memory:", POOL_COORDINATOR_URL: "http://127.0.0.1:3001", EPOCH_SECONDS: "600" });
const snapshot = (address: Hex | null = A, start = 0, end = 40, node = "1") => ({ node_id: `0x${node.repeat(40)}`, owner_account: "acc_provider", payout_address: address, layers: [start, end] });
const request = (over: Partial<PaidRequest> = {}): PaidRequest => ({ req_id: "req_1", model: "Qwen/Qwen3-14B-FP8", status: "ok", x402_payer: "0.0.9", x402_tx: "0.0.9@1.1", x402_amount_tinybar: "2000000", payout_snapshot: JSON.stringify([snapshot()]), ...over });

function seed(db: ReturnType<typeof openDb>, r = request(), ts = 610_000) {
  db.prepare(`INSERT INTO requests (req_id, model, status, pay_type, x402_payer, x402_tx, x402_amount_tinybar, payout_snapshot, prompt_hash, ts)
    VALUES (?, ?, ?, 'x402', ?, ?, ?, ?, ?, ?)`).run(r.req_id, r.model, r.status, r.x402_payer, r.x402_tx, r.x402_amount_tinybar, r.payout_snapshot, `0x${"0".repeat(64)}`, ts);
}

import { FakeChain } from "./fake-settlement.ts";
const hcsConfirmed = (db: ReturnType<typeof openDb>) => db.prepare("UPDATE ledger_events SET hcs_seq = id WHERE hcs_seq IS NULL").run();

// This vector is also verified by the Solidity tests, including the promoted odd leaf.
test("Merkle roots, leaves and proof paths reproduce the Solidity vector exactly", () => {
  const v = JSON.parse(readFileSync(new URL("../../contracts/test/fixtures/merkle-vector.json", import.meta.url), "utf8"));
  const tree = payoutTree(1, v.leaves);
  assert.equal(tree.root, v.root);
  for (const leaf of v.leaves) {
    assert.equal(payoutLeaf(leaf.payout_address, BigInt(leaf.amount_tinybar)), leaf.leaf);
    assert.deepEqual(tree.proofs.find((p) => p.payout_address === leaf.payout_address)!.proof, leaf.proof);
    assert.ok(verifyPayoutProof(leaf.payout_address, BigInt(leaf.amount_tinybar), leaf.proof, tree.root));
    assert.equal(verifyPayoutProof(leaf.payout_address, BigInt(leaf.amount_tinybar) + 1n, leaf.proof, tree.root), false);
  }
  assert.equal(payoutTree(1, [v.single]).root, v.single.root);
  assert.deepEqual(payoutTree(1, [v.single]).proofs[0]!.proof, []);
  assert.equal(payoutTree(1, []).root, ZERO_ROOT);
});

test("provider amounts use 80% and per-request layer floors; aggregate wallets, exclude self/missing/failed/unknown shares", () => {
  const rows = [request({ payout_snapshot: JSON.stringify([snapshot(A, 0, 20), snapshot(PAYER, 20, 29, "2"), snapshot(B, 29, 40, "3")]) }), request({ req_id: "req_2", x402_amount_tinybar: "1" }), request({ status: "failed" }), request({ payout_snapshot: null })];
  const result = providerPayouts(cfg, rows, new Map([["0.0.9", PAYER]]));
  assert.deepEqual(result, [{ payout_address: A, amount_tinybar: "800000" }, { payout_address: B, amount_tinybar: "440000" }]);
  const huge = 10n ** 22n + 13n;
  assert.equal(providerPayouts(cfg, [request({ x402_amount_tinybar: huge.toString() })], new Map([["0.0.9", PAYER]]))[0]!.amount_tinybar, (huge * 8000n / 10_000n).toString());
  assert.deepEqual(providerPayouts(cfg, [request({ payout_snapshot: JSON.stringify([snapshot(null)]) })], new Map([["0.0.9", PAYER]])), []);
  assert.throws(() => providerPayouts(cfg, [request()], new Map()), /unresolved/);
  assert.throws(() => providerPayouts(cfg, [request({ payout_snapshot: JSON.stringify([snapshot(A, 0, 20)]) })], new Map([["0.0.9", PAYER]])), /layer map/);
});

test("duplicate payout addresses combine; tinybars → JSON-RPC weibars is exact and never converts claim amounts", () => {
  const tree = payoutTree(1, [{ payout_address: A, amount_tinybar: "2" }, { payout_address: A, amount_tinybar: "3" }, { payout_address: B, amount_tinybar: "0" }]);
  assert.deepEqual(tree.payouts, [{ payout_address: A, amount_tinybar: "5" }]);
  assert.equal(tinybarsToWeibars(100_000_000n), 10n ** 18n);
  assert.equal(tinybarsToWeibars(1n), 10n ** 10n);
  assert.throws(() => tinybarsToWeibars(-1n), /negative/);
});

test("epoch closes atomically, waits for HCS, funds and posts once, exposes only confirmed proofs", async () => {
  const db = openDb(":memory:"); const chain = new FakeChain(); const job = createSettlement(db, cfg, signer, chain);
  try {
    seed(db);
    await job.runOnce(NOW);
    assert.equal(chain.funds, 0);
    assert.equal(chain.posts, 0);
    assert.deepEqual(payoutsFor(db, A).payouts, []);
    const ev = LedgerEvent.parse(JSON.parse((db.prepare("SELECT payload FROM ledger_events").get() as { payload: string }).payload));
    assert.equal(ev.type, "epoch_closed");
    assert.equal(ev.type === "epoch_closed" && ev.total_tinybar, "1600000");
    hcsConfirmed(db);
    await job.runOnce(NOW);
    const locked = PayoutsResponse.parse(payoutsFor(db, A, NOW));
    assert.equal(locked.payouts[0]!.claimable, false);
    assert.equal(locked.payouts[0]!.claimable_at, 1_260_000);
    assert.equal(payoutsFor(db, A, 1_260_000).payouts[0]!.claimable, true);
    await job.runOnce(NOW);
    assert.equal(chain.funds, 1); assert.equal(chain.posts, 1);
    assert.equal((db.prepare("SELECT count(*) AS n FROM ledger_events WHERE type='epoch_closed'").get() as { n: number }).n, 1);
  } finally { db.close(); }
});

test("pending requests defer their epoch; exact boundaries and duplicate payment IDs cannot double-pay", async () => {
  const db = openDb(":memory:"); const chain = new FakeChain(); const job = createSettlement(db, cfg, signer, chain);
  try {
    seed(db, request({ status: "pending" }));
    await job.closeDue(NOW);
    assert.equal((db.prepare("SELECT count(*) AS n FROM epochs").get() as { n: number }).n, 0);
    db.prepare("UPDATE requests SET status='ok'").run();
    seed(db, request({ req_id: "req_2" }), NOW); // same payment, next epoch
    await job.closeDue(NOW);
    assert.equal((db.prepare("SELECT count(*) AS n FROM epochs").get() as { n: number }).n, 1);
    await job.closeDue(NOW + 600_000);
    const second = db.prepare("SELECT total_tinybar, status FROM epochs WHERE epoch=2").get() as { total_tinybar: string; status: string };
    assert.equal(second.status, "empty"); assert.equal(second.total_tinybar, "0");
  } finally { db.close(); }
});

test("zero-provider epochs never fund or post; invalid/unresolved data fails before closing", async () => {
  const db = openDb(":memory:"); const chain = new FakeChain(); const job = createSettlement(db, cfg, signer, chain);
  try {
    seed(db, request({ payout_snapshot: null }));
    await job.runOnce(NOW); hcsConfirmed(db); await job.runOnce(NOW);
    assert.equal(chain.funds, 0); assert.equal(chain.posts, 0);
    assert.equal((db.prepare("SELECT status FROM epochs").get() as { status: string }).status, "empty");
    seed(db, request({ req_id: "req_bad", x402_tx: "0.0.9@2.2", payout_snapshot: "{}" }), NOW + 1);
    await assert.rejects(job.closeDue(NOW + 600_000));
    assert.equal((db.prepare("SELECT count(*) AS n FROM epochs").get() as { n: number }).n, 1);
  } finally { db.close(); }
});

test("restart after funding and RPC failure reuses persisted signed transactions; never transfers twice", async () => {
  const db = openDb(":memory:"); const chain = new FakeChain(); const job = createSettlement(db, cfg, signer, chain);
  try {
    seed(db); await job.closeDue(NOW); hcsConfirmed(db);
    chain.failReceiptAfterFunding = true;
    await assert.rejects(job.runOnce(NOW), /RPC unavailable/);
    assert.equal(chain.funds, 1); assert.equal(chain.posts, 0);
    await createSettlement(db, cfg, signer, chain).runOnce(NOW);
    assert.equal(chain.funds, 1); assert.equal(chain.posts, 1); assert.equal(chain.prepares, 2);
  } finally { db.close(); }
});

test("pending funding reuses one hash; conflicting contract roots prevent any treasury transfer", async () => {
  const db = openDb(":memory:"); const chain = new FakeChain(); const job = createSettlement(db, cfg, signer, chain);
  try {
    seed(db); await job.closeDue(NOW); hcsConfirmed(db);
    chain.holdReceipts = true;
    await job.runOnce(NOW); await job.runOnce(NOW);
    assert.equal(chain.prepares, 1); assert.equal(chain.posts, 0);
    chain.holdReceipts = false;
    await job.runOnce(NOW);
    assert.equal(chain.funds, 1); assert.equal(chain.posts, 1);
    seed(db, request({ req_id: "req_next", x402_tx: "0.0.9@3.3" }), NOW + 1);
    await job.closeDue(NOW + 600_000); hcsConfirmed(db);
    chain.states.set(2, { root: keccak256('0x01'), total: 1n, claimed: 0n, postedAt: 1n });
    await assert.rejects(job.runOnce(NOW + 600_000), /conflicts/);
    assert.equal(chain.funds, 1);
  } finally { db.close(); }
});

test("large payout lists commit their canonical hash with a sub-1KB HCS event", async () => {
  const db = openDb(":memory:"); const chain = new FakeChain(); const job = createSettlement(db, cfg, signer, chain);
  try {
    for (let i = 1; i <= 12; i++) seed(db, request({ req_id: `req_${i}`, x402_tx: `0.0.9@${i}.1`, payout_snapshot: JSON.stringify([snapshot(`0x${i.toString(16).padStart(40, '0')}`)]) }));
    await job.closeDue(NOW);
    const payload = (db.prepare("SELECT payload FROM ledger_events").get() as { payload: string }).payload;
    const event = JSON.parse(payload);
    assert.equal(event.payouts, null);
    assert.ok(Buffer.byteLength(payload) < 1024);
    const list = (db.prepare("SELECT payout_address, amount_tinybar FROM epoch_payouts ORDER BY payout_address").all() as { payout_address: string; amount_tinybar: string }[]);
    assert.equal(event.payouts_hash, keccak256(toHex(canonicalJson(list))));
  } finally { db.close(); }
});

test("provider API, confirmed claim logs and HCS history are idempotent; swept funds are not claimable", async () => {
  const db = openDb(":memory:"); const chain = new FakeChain(); const job = createSettlement(db, cfg, signer, chain);
  try {
    seed(db); await job.closeDue(NOW); hcsConfirmed(db); await job.runOnce(NOW);
    const app = createApp({ cfg, db, signer, directory: { models: async () => [], pools: async () => [], nodes: async () => [], readyPools: async () => [] } });
    assert.equal((await app.request('/payouts/invalid')).status, 400);
    assert.equal((await app.request(`/payouts/${B}`)).status, 200);
    const proof = PayoutsResponse.parse(await (await app.request(`/payouts/${A}`)).json()).payouts[0]!;
    assert.ok(verifyPayoutProof(A, BigInt(proof.amount_tinybar), proof.proof as Hex[], proof.merkle_root as Hex));
    const tx = keccak256('0x1234');
    chain.events.push({ epoch: 1, block: ++chain.block, event: { type: "claim", address: A, amount: 1_600_000n, tx } });
    await job.runOnce(NOW); await job.runOnce(NOW);
    const claimed = payoutsFor(db, A).payouts[0]!;
    assert.equal(claimed.claimed, true); assert.equal(claimed.claimable, false); assert.equal(claimed.claim_tx, tx);
    assert.equal((db.prepare("SELECT count(*) AS n FROM ledger_events WHERE type='payout_claimed'").get() as { n: number }).n, 1);
    // Another epoch is swept without a provider claim.
    seed(db, request({ req_id: "req_later", x402_tx: "0.0.9@20.1" }), NOW + 1);
    await job.closeDue(NOW + 600_000); hcsConfirmed(db); await job.runOnce(NOW + 600_000);
    chain.events.push({ epoch: 2, block: ++chain.block, event: { type: "sweep", tx: keccak256('0x2345') } });
    await job.runOnce(NOW + 600_000);
    const swept = payoutsFor(db, A).payouts.find((p) => p.epoch === 2)!;
    assert.equal(swept.swept, true); assert.equal(swept.claimable, false);
  } finally { db.close(); }
});

test("reverted posting keeps proofs hidden and reuses the recorded transaction instead of funding again", async () => {
  const db = openDb(":memory:"); const chain = new FakeChain(); const job = createSettlement(db, cfg, signer, chain);
  try {
    seed(db); await job.closeDue(NOW); hcsConfirmed(db);
    const original = chain.preparePost;
    chain.preparePost = async (epoch, root, amount) => {
      const tx = await original(epoch, root, amount);
      chain.receipts.set(tx.hash, { status: "reverted", blockNumber: ++chain.block });
      return tx;
    };
    await assert.rejects(job.runOnce(NOW), /reverted/);
    await assert.rejects(createSettlement(db, cfg, signer, chain).runOnce(NOW), /reverted/);
    assert.deepEqual(payoutsFor(db, A).payouts, []);
    assert.equal(chain.funds, 1); assert.equal(chain.prepares, 2);
  } finally { db.close(); }
});
