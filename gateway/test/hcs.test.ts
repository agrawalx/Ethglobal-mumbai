import { test } from "node:test";
import assert from "node:assert/strict";
import { canonicalJson, LedgerEvent } from "@gpupool/shared";
import { openDb } from "../src/db.ts";
import { recordEvent, signEvent, signerFromSeed, verifyEvent } from "../src/events.ts";
import { flushOnce, startHcsWriter } from "../src/hcs.ts";
import { signer, TEST_SEED } from "./helpers.ts";

test("signing: sig = ed25519 over canonical JSON without sig; verify helper accepts it and rejects tampering", () => {
  const ev = signEvent(signer, { type: "account_created", account_id: "acc_abc" }, 1793912345123);
  assert.equal(LedgerEvent.parse(ev).type, "account_created");
  assert.equal(ev.v, 1);
  assert.equal(ev.ts, 1793912345123);
  assert.match(ev.sig, /^0x[0-9a-f]{128}$/);
  assert.equal(verifyEvent(ev, signer.publicKeyHex), true);
  assert.equal(verifyEvent({ ...ev, account_id: "acc_evil" }, signer.publicKeyHex), false);
  // key order does not matter: verify uses canonical JSON
  const reordered = JSON.parse(JSON.stringify({ sig: ev.sig, type: ev.type, ts: ev.ts, v: ev.v, account_id: (ev as { account_id: string }).account_id }));
  assert.equal(verifyEvent(reordered, signer.publicKeyHex), true);
  const other = signerFromSeed("22".repeat(32));
  assert.equal(verifyEvent(ev, other.publicKeyHex), false);
});

test("signing is deterministic (ed25519) and the public key is stable for a seed", () => {
  const a = signEvent(signer, { type: "account_created", account_id: "acc_abc" }, 1);
  const b = signEvent(signerFromSeed(TEST_SEED), { type: "account_created", account_id: "acc_abc" }, 1);
  assert.equal(a.sig, b.sig);
  assert.match(signer.publicKeyHex, /^0x[0-9a-f]{64}$/);
  assert.throws(() => signerFromSeed("abc"), /32-byte/);
});

test("recordEvent stores the canonical JSON (with sig), hcs_seq NULL", () => {
  const db = openDb(":memory:");
  const ev = recordEvent(db, signer, { type: "account_created", account_id: "acc_abc" });
  const row = db.prepare("SELECT type, payload, gateway_sig, hcs_seq FROM ledger_events").get() as { type: string; payload: string; gateway_sig: string; hcs_seq: number | null };
  assert.equal(row.payload, canonicalJson(ev));
  assert.equal(row.gateway_sig, ev.sig);
  assert.equal(row.hcs_seq, null);
  db.close();
});

test("queue: submits in id order, fills ledger_events.hcs_seq and requests.hcs_seq", async () => {
  const db = openDb(":memory:");
  db.prepare("INSERT INTO accounts (id, world_nullifier, created_at) VALUES ('acc_a', 'n', 1)").run();
  db.prepare("INSERT INTO requests (req_id, account_id, model, pay_type, route, status, prompt_hash, ts) VALUES ('req_1', 'acc_a', 'm', 'credits', NULL, 'ok', '0x00', 1)").run();
  recordEvent(db, signer, { type: "account_created", account_id: "acc_a" });
  recordEvent(db, signer, {
    type: "request_settled", req_id: "req_1", account_id: "acc_a", model: "m", in_tokens: 1, out_tokens: 1, cost_mc: 10,
    split: { nodes: {}, burn_mc: 0, reserve_mc: 10 }, pay: "credits", prompt_hash: `0x${"ab".repeat(32)}`, resp_hash: `0x${"cd".repeat(32)}`,
  });
  const sent: string[] = [];
  let seq = 100;
  const n = await flushOnce(db, async (m) => { sent.push(JSON.parse(m).type); return ++seq; });
  assert.equal(n, 2);
  assert.deepEqual(sent, ["account_created", "request_settled"]);
  assert.deepEqual((db.prepare("SELECT hcs_seq FROM ledger_events ORDER BY id").all() as { hcs_seq: number }[]).map((r) => r.hcs_seq), [101, 102]);
  assert.equal((db.prepare("SELECT hcs_seq FROM requests WHERE req_id = 'req_1'").get() as { hcs_seq: number }).hcs_seq, 102);
  assert.equal(await flushOnce(db, async () => { throw new Error("must not be called"); }), 0);
  db.close();
});

test("queue: a failed submit keeps the row (and later rows) unsent; a retry sends them in order", async () => {
  const db = openDb(":memory:");
  recordEvent(db, signer, { type: "account_created", account_id: "acc_a" });
  recordEvent(db, signer, { type: "account_created", account_id: "acc_b" });
  let calls = 0;
  await assert.rejects(flushOnce(db, async () => { calls++; throw new Error("network down"); }), /network down/);
  assert.equal(calls, 1);
  assert.equal((db.prepare("SELECT count(*) AS n FROM ledger_events WHERE hcs_seq IS NULL").get() as { n: number }).n, 2);
  const order: string[] = [];
  let fail = true;
  const stop = startHcsWriter(db, async (m) => {
    if (fail) { fail = false; throw new Error("flaky"); }
    order.push(JSON.parse(m).account_id);
    return order.length;
  }, 10);
  const end = Date.now() + 2000;
  while (order.length < 2 && Date.now() < end) await new Promise((r) => setTimeout(r, 10));
  stop();
  assert.deepEqual(order, ["acc_a", "acc_b"]);
  assert.equal((db.prepare("SELECT count(*) AS n FROM ledger_events WHERE hcs_seq IS NULL").get() as { n: number }).n, 0);
  db.close();
});
