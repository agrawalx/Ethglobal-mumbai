import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { bytesToHex } from "viem";
import { render } from "@arkiv-network/sdk/query";
import { decode, encode, POOL_MODEL_SLOTS, readyPoolsWhere, nodesWhere, type Kind, type Row } from "../src/schema.ts";
import { listReadyPools } from "../src/reader.ts";
import { upsert, ttlFor, extendSeconds } from "../src/writer.ts";
import { GpupoolConfig } from "@gpupool/shared";

const example = (f: string) => JSON.parse(readFileSync(new URL(`../../shared/examples/${f}`, import.meta.url), "utf8"));
const cfg = GpupoolConfig.parse(JSON.parse(readFileSync(new URL("../../shared/config/gpupool.config.json", import.meta.url), "utf8")));

/** What the SDK returns for a row: each column {type, value}, bytes as hex. */
function asRow(values: Record<string, string | Uint8Array>, key = "0x01"): Row {
  const row: Row = { $key: key };
  for (const [k, v] of Object.entries(values)) row[k] = typeof v === "string" ? { type: "str", value: v } : { type: "bytes", value: bytesToHex(v) };
  return row;
}

const CASES: [Kind, string][] = [
  ["node", "arkiv-node.json"],
  ["pool", "arkiv-pool.json"],
  ["model", "arkiv-model.json"],
  ["accountStats", "arkiv-account-stats.json"],
];

for (const [kind, file] of CASES) {
  test(`round-trip ${file}`, () => {
    const entity = example(file);
    const values = encode(kind, entity);
    const d = decode(kind, asRow(values));
    assert.ok(d.ok, d.ok ? "" : d.error);
    assert.deepEqual(d.entity, entity);
  });
}

test("indexed fields become str columns; the rest go to the JSON payload", () => {
  const v = encode("node", example("arkiv-node.json"));
  assert.deepEqual(Object.keys(v).sort(), ["gpu", "node_id", "owner_account", "payload", "pool_id", "status", "type"]);
  const payload = JSON.parse(new TextDecoder().decode(v.payload as Uint8Array));
  assert.deepEqual(payload, { mem_gb: 16, layers: [0, 20], tok_s: 5.6, reliability: 0.97 });
});

test("pool models go to indexed slots", () => {
  const pool = { ...example("arkiv-pool.json"), models: ["a/one", "b/two"] };
  const v = encode("pool", pool);
  assert.equal(v.model0, "a/one");
  assert.equal(v.model1, "b/two");
  assert.equal("model2" in v, false);
  assert.equal("models" in JSON.parse(new TextDecoder().decode(v.payload as Uint8Array)), false);
  assert.throws(() => encode("pool", { ...pool, models: ["1", "2", "3", "4", "5"] }), /at most 4/);
});

test("query builder: ready pools for a model, nodes of a pool", () => {
  const q = render(readyPoolsWhere("Qwen/Qwen3-14B-FP8"));
  const slots = POOL_MODEL_SLOTS.map((s) => `${s} = str('Qwen/Qwen3-14B-FP8')`).join(" OR ");
  assert.equal(q, `status = str('ready') AND (${slots})`);
  assert.equal(render(nodesWhere("pool-mumbai-1")), "pool_id = str('pool-mumbai-1')");
});

test("failure path: invalid entities are rejected on encode and skipped on read", async () => {
  assert.throws(() => encode("node", { ...example("arkiv-node.json"), status: "dancing" }));
  const good = asRow(encode("pool", example("arkiv-pool.json")), "0xgood");
  const bad = { ...good, $key: "0xbad", status: { type: "str", value: "exploded" } };
  const junk = { ...good, $key: "0xjunk", payload: { type: "bytes", value: "0x7b7b" } };
  assert.equal(decode("pool", bad).ok, false);
  assert.equal(decode("pool", junk).ok, false);

  // Fake public client: records the query chain, returns the rows.
  const calls: string[] = [];
  const chain: any = {
    from: () => (calls.push("from"), chain),
    where: (e: any) => (calls.push(`where ${render(e)}`), chain),
    ownedBy: (a: string) => (calls.push(`ownedBy ${a}`), chain),
    limit: (n: number) => (calls.push(`limit ${n}`), chain),
    fetch: async () => ({ entities: [good, bad, junk], skipped: 0 }),
  };
  const pub: any = { select: () => chain };
  const warn = console.warn;
  const warnings: string[] = [];
  console.warn = (m: string) => warnings.push(m);
  try {
    const pools = await listReadyPools(pub, "Qwen/Qwen3-14B-FP8");
    assert.equal(pools.length, 1);
    assert.equal(pools[0]!.pool_id, "pool-mumbai-1");
  } finally {
    console.warn = warn;
  }
  assert.equal(warnings.length, 2);
  assert.ok(calls.some((c) => c.startsWith("where status = str('ready')")));
});

test("upsert: creates once, then patches + extends in one batch", async () => {
  const owner = "0x00000000000000000000000000000000000000aa";
  let existing: string | null = null;
  const queries: string[] = [];
  const chain: any = {
    from: () => chain,
    where: (e: any) => (queries.push(render(e)), chain),
    ownedBy: (a: string) => (queries.push(`owner ${a}`), chain),
    limit: () => chain,
    fetch: async () => ({ entities: existing ? [{ $key: existing }] : [], skipped: 0 }),
  };
  const pub: any = { select: () => chain };
  const sent: any[] = [];
  const wallet: any = {
    account: { address: owner },
    createEntity: async (_s: unknown, values: unknown, opts: any) => (sent.push({ create: values, opts }), { entityKey: "0xkey", txHash: "0xtx1" }),
    executeBatch: async (b: any) => (sent.push({ batch: b }), { txHash: "0xtx2" }),
  };
  const node = example("arkiv-node.json");
  const ttl = ttlFor(cfg, "node");
  assert.equal(ttl, 120);

  const a = await upsert(pub, wallet, "node", node, ttl);
  assert.deepEqual(a, { entityKey: "0xkey", txHash: "0xtx1", created: true });
  assert.deepEqual(queries, [`node_id = str('${node.node_id}')`, `owner ${owner}`]);

  existing = "0xkey";
  const b = await upsert(pub, wallet, "node", { ...node, status: "offline" }, ttl);
  assert.deepEqual(b, { entityKey: "0xkey", txHash: "0xtx2", created: false });
  const batch = sent[1].batch;
  assert.equal(batch.patches.length, 1);
  assert.equal(batch.patches[0].set.status, "offline");
  assert.equal(batch.extensions[0].entityKey, "0xkey");
  assert.equal(batch.creates, undefined);
});

test("extend interval env", () => {
  assert.equal(extendSeconds({}), 30);
  assert.equal(extendSeconds({ ARKIV_EXTEND_SECONDS: "10" }), 10);
  assert.throws(() => extendSeconds({ ARKIV_EXTEND_SECONDS: "x" }));
});
