import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { ArkivAccountStats } from '@gpupool/shared';
import { accountStatsSnapshot, startAccountStatsPublisher } from '../src/account-stats.ts';
import { createApp } from '../src/app.ts';
import { loadConfig } from '../src/config.ts';
import { openDb } from '../src/db.ts';
import { signer, testAccount, testDirectory, TEST_JWT_SECRET, TEST_NODE } from './helpers.ts';
import { recordHeartbeat, countRouted } from '../src/reliability.ts';
const cfg = loadConfig({ DATABASE_PATH: ':memory:', POOL_COORDINATOR_URL: 'http://127.0.0.1:3001', JWT_SECRET: TEST_JWT_SECRET });

test('account stats publish cumulative earned/spent, contribution ratio and minimum score; omit all private fields', async () => {
  const db = openDb(':memory:');
  try {
    testDirectory(cfg, db);
    const account = await testAccount(db, cfg);
    db.prepare('UPDATE balances SET earned_total_mc = 5000, spent_total_mc = 2000, earned_mc = 3000 WHERE account_id = ?').run(account.accountId);
    db.prepare('INSERT INTO node_reliability (node_id, score, updated_at) VALUES (?, 0.8, ?)').run(TEST_NODE, Date.now());
    recordHeartbeat(db, cfg, TEST_NODE, true);
    countRouted(db, cfg, [{ node_id: TEST_NODE, layers: [0,40] }], false);
    const stats = accountStatsSnapshot(db, cfg);
    const human = stats.find((s) => s.account_id === account.accountId)!;
    assert.equal(human.earned_mc, 5000); assert.equal(human.spent_mc, 2000); assert.equal(human.ratio, 2.5);
    assert.equal(human.reliability, null);
    assert.equal(stats.find((s) => s.account_id === 'acc_router')!.reliability, 0.3);
    for (const row of stats) {
      ArkivAccountStats.parse(row);
      assert.deepEqual(Object.keys(row).sort(), ['account_id','earned_mc','ratio','reliability','spent_mc','type']);
    }
    assert.ok(!JSON.stringify(stats).includes('nullifier'));
  } finally { db.close(); }
});

test('publisher isolates failures, retries next batch, never overlaps, and never blocks API requests', async () => {
  const db = openDb(':memory:');
  let resolveWrite!: () => void;
  const blocked = new Promise<void>((resolve) => { resolveWrite = resolve; });
  try {
    const directory = testDirectory(cfg, db);
    await testAccount(db, cfg);
    let calls = 0;
    let failedOnce = false;
    const publisher = startAccountStatsPublisher(db, cfg, async (row) => {
      calls++;
      if (calls === 1) await blocked;
      if (row.account_id === 'acc_router' && !failedOnce) { failedOnce = true; throw new Error('write rejected'); }
    });
    const first = publisher.runOnce();
    assert.equal(publisher.runOnce(), first);
    const app = createApp({ cfg, db, signer, directory });
    assert.equal((await app.request('/healthz')).status, 200);
    assert.equal((await app.request('/ledger/events')).status, 200);
    resolveWrite();
    assert.deepEqual(await first, { written: 1, failed: 1 });
    assert.equal(calls, 2);
    assert.deepEqual(await publisher.runOnce(), { written: 2, failed: 0 });
    await publisher.stop();
    assert.deepEqual(await publisher.runOnce(), { written: 0, failed: 0 });
    assert.equal(calls, 4);
  } finally { resolveWrite(); db.close(); }
});

test('timer publishes at startup and on its schedule, then stops', async () => {
  const db = openDb(':memory:');
  try {
    await testAccount(db, cfg);
    let calls = 0;
    const publisher = startAccountStatsPublisher(db, cfg, async () => { calls++; }, 20);
    const deadline = Date.now() + 2000;
    while (calls < 2 && Date.now() < deadline) await delay(5);
    assert.ok(calls >= 2);
    await publisher.stop();
    const stoppedAt = calls;
    await delay(50);
    assert.equal(calls, stoppedAt);
  } finally { db.close(); }
});
