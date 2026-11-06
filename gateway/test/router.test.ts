import { test } from "node:test";
import assert from "node:assert/strict";
import { keccak256, toBytes } from "viem";
import type { ArkivPool } from "@gpupool/shared";
import { loadConfig } from "../src/config.ts";
import { openDb } from "../src/db.ts";
import { createApp } from "../src/app.ts";
import { createRouter, type Directory } from "../src/router.ts";
import { poolContextLength, poolState } from "../src/route.ts";
import { balance, signer, testAccount, testDirectory, TEST_JWT_SECRET, TEST_NODE } from "./helpers.ts";

const MODEL = "Qwen/Qwen3-14B-FP8";

test("context minimum uses fresh nodes; stale/offline limits ignored and unknown limits stay optional", async () => {
  const { cfg, db, fake, model } = setup();
  try {
    const now = Date.now();
    db.prepare("UPDATE nodes SET hb_max_seq = 16384").run();
    const other = "0x" + "d".repeat(40);
    db.prepare(`INSERT INTO nodes (node_id, account_id, pool_id, gpu, mem_gb, registered_at, hb_ts, hb_online, hb_model, hb_max_seq)
      VALUES (?, 'acc_router', 'pool-router-test', 'fixture', 16, ?, ?, 1, ?, 8192)`).run(other, now, now, MODEL);
    assert.equal(poolContextLength(db, cfg.net, "pool-router-test", model, now), 8192);
    assert.equal(poolState(db, cfg, "pool-router-test", now).context_length, 8192);
    assert.equal((await createRouter(cfg, db, fake).models()).data.find((m) => m.id === MODEL)?.context_length, 8192);
    db.prepare("UPDATE nodes SET hb_ts = ? WHERE node_id = ?").run(now - 31_000, other);
    assert.equal(poolContextLength(db, cfg.net, "pool-router-test", model, now), 16384);
    db.prepare("UPDATE nodes SET hb_ts = ?, hb_online = 0 WHERE node_id = ?").run(now, other);
    assert.equal(poolContextLength(db, cfg.net, "pool-router-test", model, now), 16384);
    db.prepare("UPDATE nodes SET hb_online = 1, hb_max_seq = NULL WHERE node_id = ?").run(other);
    assert.equal(poolContextLength(db, cfg.net, "pool-router-test", model, now), undefined);
  } finally { db.close(); }
});
function setup() {
  const cfg = loadConfig({ DATABASE_PATH: ":memory:", POOL_COORDINATOR_URL: "http://127.0.0.1:3001", JWT_SECRET: TEST_JWT_SECRET });
  const db = openDb(":memory:");
  const fake = testDirectory(cfg, db);
  return { cfg, db, fake, model: cfg.model(MODEL)! };
}

test("discovery requires both an Arkiv catalog entry and a fresh ready pool; never probes Parallax", async () => {
  const { cfg, db, fake, model } = setup();
  try {
    const catalog = (await fake.models()).filter((m) => m.model_id === MODEL);
    const directory: Directory = { ...fake, models: async () => catalog };
    const router = createRouter(cfg, db, directory);
    const result = await router.models();
    assert.deepEqual(result.data.map((m) => [m.id, m.pools, m.source]), [[MODEL, 1, "arkiv"]]);
    assert.deepEqual((await createRouter(cfg, db, { ...directory, models: async () => [] }).models()).data, []);
    const selected = await router.select(model);
    assert.equal(selected?.poolId, "pool-router-test");
    assert.equal(selected?.coordinatorUrl, cfg.env.POOL_COORDINATOR_URL);
    assert.deepEqual(selected?.route, [{ node_id: TEST_NODE, layers: [0, 40] }]);
    db.prepare("UPDATE nodes SET hb_ts = ?").run(Date.now() - 31_000);
    assert.equal(await router.select(model), null);
    assert.deepEqual((await router.models()).data, []);
  } finally { db.close(); }
});

test("router rejects offline, wrong-model, unknown URL, unregistered, wrong-pool, and stale-member listings", async () => {
  const { cfg, db, fake, model } = setup();
  try {
    const base = (await fake.readyPools(MODEL))[0]!;
    const wrong = "0x" + "e".repeat(40);
    const cases: Partial<ArkivPool>[] = [
      { status: "loading" }, { models: ["unknown"] }, { members: [] },
      { coordinator_url_hash: keccak256(toBytes("http://unknown:3001")) },
      { members: [wrong] }, { pool_id: "another-pool" }, { members: [TEST_NODE, wrong] },
    ];
    for (const change of cases) {
      const router = createRouter(cfg, db, { ...fake, readyPools: async () => [{ ...base, ...change }] });
      assert.equal(await router.select(model), null, JSON.stringify(change));
    }
    db.prepare("UPDATE nodes SET hb_model = 'Qwen/Qwen3-8B'").run();
    assert.equal(await createRouter(cfg, db, fake).select(model), null);
    db.prepare("UPDATE nodes SET hb_online = 0").run();
    assert.equal(await createRouter(cfg, db, fake).select(model), null);
  } finally { db.close(); }
});

test("score uses minimum member reliability and active request load; release is idempotent", async () => {
  const { cfg, db, fake, model } = setup();
  try {
    const a = (await fake.readyPools(MODEL))[0]!;
    const bNode = "0x" + "b".repeat(40);
    db.prepare(`INSERT INTO nodes (node_id, account_id, pool_id, gpu, mem_gb, registered_at, hb_ts, hb_online, hb_model, hb_layers)
      VALUES (?, 'acc_router', 'pool-b', 'fixture', 8, ?, ?, 1, ?, '[0,40]')`).run(bNode, Date.now(), Date.now(), MODEL);
    db.prepare("INSERT INTO node_reliability (node_id, score, updated_at) VALUES (?, 0.9, ?), (?, 0.6, ?)").run(TEST_NODE, Date.now(), bNode, Date.now());
    const b = { ...a, pool_id: "pool-b", members: [bNode] };
    const router = createRouter(cfg, db, { ...fake, readyPools: async () => [b, a, a] });
    assert.equal((await router.select(model))?.poolId, a.pool_id);
    assert.equal((await router.models()).data.find((m) => m.id === MODEL)?.pools, 2);
    const release = router.start(a.pool_id);
    assert.equal((await router.select(model))?.poolId, b.pool_id);
    release(); release();
    assert.equal((await router.select(model))?.poolId, a.pool_id);
    // A second member with lower reliability determines the pool score.
    db.prepare("UPDATE nodes SET pool_id = ? WHERE node_id = ?").run(a.pool_id, bNode);
    const minRouter = createRouter(cfg, db, { ...fake, readyPools: async () => [{ ...a, members: [TEST_NODE, bNode] }] });
    assert.equal((await minRouter.select(model))?.score, 0.6);
  } finally { db.close(); }
});

test("receipt route stays scoped to selected pool; incomplete heartbeat coverage stays unknown", async () => {
  const { cfg, db, fake, model } = setup();
  try {
    db.prepare("UPDATE nodes SET hb_layers = '[0,20]'").run();
    const selected = await createRouter(cfg, db, fake).select(model);
    assert.ok(selected);
    assert.equal(selected.route, null);
  } finally { db.close(); }
});

test("no pools / Arkiv outage → 503 + Retry-After before a credit hold, payment, or inference", async () => {
  const { cfg, db, fake } = setup();
  try {
    const account = await testAccount(db, cfg);
    let charges = 0;
    for (const unavailable of [async () => [], async () => { throw new Error("RPC unavailable"); }]) {
      const app = createApp({ cfg, db, signer, directory: { ...fake, readyPools: unavailable },
        x402: { charge: async () => { charges++; throw new Error("must not charge"); }, topup: async () => { throw new Error("unused"); } } });
      for (const auth of [account.auth, {}]) {
        const response = await app.request("/v1/chat/completions", { method: "POST", headers: { "content-type": "application/json", ...auth },
          body: JSON.stringify({ model: MODEL, messages: [{ role: "user", content: "hello" }] }) });
        assert.equal(response.status, 503);
        assert.equal(response.headers.get("Retry-After"), String(cfg.net.router.retry_after_s));
        assert.equal((await response.json()).error.code, "no_pool_available");
      }
      assert.equal(balance(db, account.accountId).held_mc, 0);
      assert.equal((db.prepare("SELECT count(*) AS n FROM requests").get() as { n: number }).n, 0);
    }
    assert.equal(charges, 0);
    const app = createApp({ cfg, db, signer, directory: { ...fake, models: async () => { throw new Error("offline"); } } });
    const res = await app.request("/v1/models");
    assert.equal(res.status, 503);
    assert.ok(res.headers.get("Retry-After"));
  } finally { db.close(); }
});

test("billing credits only the selected Arkiv pool, ignoring another pool and the advertised layer map", async () => {
  const { cfg, db, fake } = setup();
  const originalFetch = globalThis.fetch;
  try {
    const other = "0x" + "a".repeat(40);
    db.prepare(`INSERT INTO nodes (node_id, account_id, pool_id, gpu, mem_gb, registered_at, hb_ts, hb_online, hb_model, hb_layers)
      VALUES (?, 'acc_router', 'aaa-other-pool', 'fixture', 8, ?, ?, 1, ?, '[0,40]')`).run(other, Date.now(), Date.now(), MODEL);
    const account = await testAccount(db, cfg);
    let forwarded = "";
    globalThis.fetch = async (url) => {
      forwarded = String(url);
      return Response.json({ choices: [{ message: { content: "hello" } }], usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 } });
    };
    const app = createApp({ cfg, db, signer, onComplete: () => {}, directory: { ...fake,
      readyPools: async (model) => (await fake.readyPools(model)).map((p) => ({ ...p, layer_map: [{ node_id: other, layers: [0, 40] }] })) } });
    const response = await app.request("/v1/chat/completions", { method: "POST", headers: { "content-type": "application/json", ...account.auth },
      body: JSON.stringify({ model: MODEL, messages: [{ role: "user", content: "hi" }] }) });
    assert.equal(response.status, 200);
    assert.equal(forwarded, "http://127.0.0.1:3001/v1/chat/completions");
    const receipt = await (await app.request(`/requests/${response.headers.get("x-gpupool-request-id")}`)).json();
    assert.deepEqual(receipt.route, [{ node_id: TEST_NODE, layers: [0, 40] }]);
    assert.deepEqual(Object.keys(receipt.split.nodes), [TEST_NODE]);
    assert.ok(balance(db, "acc_router").locked_mc > 0); // SPEC §16.3: earnings vest first
    assert.equal(balance(db, account.accountId).held_mc, 0);
  } finally { globalThis.fetch = originalFetch; db.close(); }
});
