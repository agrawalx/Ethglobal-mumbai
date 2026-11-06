import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { LedgerEventsResponse, NetworkResponse, type ArkivNode, type ArkivPool } from "@gpupool/shared";
import { loadConfig } from "../src/config.ts";
import { openDb } from "../src/db.ts";
import { createApp } from "../src/app.ts";
import { recordEvent, verifyEvent } from "../src/events.ts";
import { flushOnce } from "../src/hcs.ts";
import { signer, testDirectory } from "./helpers.ts";

const cfg = loadConfig({ DATABASE_PATH: ':memory:', POOL_COORDINATOR_URL: 'http://127.0.0.1:3001' });
const example = (name: string) => JSON.parse(readFileSync(new URL(`../../shared/examples/${name}`, import.meta.url), 'utf8'));

test("/network returns every Arkiv pool status and owner-signed node record, with minimum reliability and no private URL", async () => {
  const db = openDb(':memory:');
  try {
    const pool: ArkivPool = example('arkiv-pool.json');
    const node: ArkivNode = example('arkiv-node.json');
    const app = createApp({ cfg, db, signer, directory: {
      models: async () => [], readyPools: async () => [],
      pools: async () => [pool, { ...pool, pool_id: 'loading-pool', members: [], status: 'loading', layer_map: null }],
      nodes: async () => [node, { ...node, node_id: pool.members[1]!, reliability: 0.4 }, { ...node, node_id: pool.members[2]!, reliability: 0.9 }],
    } });
    const response = await app.request('/network');
    assert.equal(response.status, 200);
    const result = NetworkResponse.parse(await response.json());
    assert.equal(result.source, 'arkiv');
    assert.equal(result.pools.length, 2);
    assert.equal(result.pools[0]!.reliability, 0.4);
    assert.equal(result.pools[0]!.load, 0);
    assert.equal(result.pools[1]!.status, 'loading');
    assert.equal(result.nodes.length, 3);
    assert.equal(JSON.stringify(result).includes('http://'), false);
  } finally { db.close(); }
});

test("/network directory outage returns 503 + Retry-After; empty live directory returns empty arrays", async () => {
  const db = openDb(':memory:');
  try {
    const base = { models: async () => [], readyPools: async () => [], nodes: async () => [], pools: async () => [] };
    const empty = createApp({ cfg, db, signer, directory: base });
    assert.deepEqual(await (await empty.request('/network')).json(), { source: 'arkiv', pools: [], nodes: [] });
    const down = createApp({ cfg, db, signer, directory: { ...base, pools: async () => { throw new Error('RPC outage'); } } });
    const res = await down.request('/network');
    assert.equal(res.status, 503);
    assert.equal(res.headers.get('Retry-After'), String(cfg.net.router.retry_after_s));
  } finally { db.close(); }
});

test("/ledger/events returns signed newest-first events with pending and backfilled HCS sequences; validates limit", async () => {
  const db = openDb(':memory:');
  try {
    const app = createApp({ cfg, db, signer, directory: testDirectory(cfg, db) });
    recordEvent(db, signer, { type: 'account_created', account_id: 'acc_first' });
    recordEvent(db, signer, { type: 'account_created', account_id: 'acc_second' });
    let result = LedgerEventsResponse.parse(await (await app.request('/ledger/events?limit=1')).json());
    assert.equal(result.events.length, 1);
    assert.equal(result.events[0]!.event.type === 'account_created' && result.events[0]!.event.account_id, 'acc_second');
    assert.equal(result.events[0]!.hcs_seq, null);
    assert.ok(verifyEvent(result.events[0]!.event, signer.publicKeyHex));
    let seq = 10;
    await flushOnce(db, async () => ++seq);
    result = LedgerEventsResponse.parse(await (await app.request('/ledger/events')).json());
    assert.deepEqual(result.events.map((e) => e.hcs_seq), [12, 11]);
    assert.ok(result.events[0]!.id > result.events[1]!.id);
    for (const limit of ['0','101','-1','1.5','abc','1e2','', '1&limit=2']) assert.equal((await app.request(`/ledger/events?limit=${limit}`)).status, 400, limit);
  } finally { db.close(); }
});
