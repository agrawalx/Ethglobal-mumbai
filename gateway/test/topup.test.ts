import { test } from "node:test";
import assert from "node:assert/strict";
import { CreditTopupResponse, KeyCreditsResponse, LedgerEvent, Receipt } from "@gpupool/shared";
import { loadConfig } from "../src/config.ts";
import { openDb, type Db } from "../src/db.ts";
import { createApp } from "../src/app.ts";
import { costMc, tryHoldForKey } from "../src/ledger.ts";
import { createAgentKey, creditTopup, topupMc } from "../src/incentives.ts";
import type { X402 } from "../src/x402.ts";
import { balance, signer, testAccount, testDirectory, TEST_JWT_SECRET } from "./helpers.ts";

const cfg = loadConfig({ DATABASE_PATH: ":memory:", POOL_COORDINATOR_URL: "http://127.0.0.1:3001", JWT_SECRET: TEST_JWT_SECRET });
const model = cfg.model("Qwen/Qwen3-14B-FP8")!;
const HBAR = 100_000_000n;

const keyRow = (db: Db, id: string) => db.prepare("SELECT key_credits_mc, key_held_mc, bought_total_mc, key_spent_mc, spent_mc FROM agent_keys WHERE id = ?").get(id) as
  { key_credits_mc: number; key_held_mc: number; bought_total_mc: number; key_spent_mc: number; spent_mc: number };
const events = (db: Db, type: string) => (db.prepare("SELECT payload FROM ledger_events WHERE type = ?").all(type) as { payload: string }[]).map((r) => LedgerEvent.parse(JSON.parse(r.payload)));

/** Fake x402: records the asked amount; each call settles a new tx unless `tx` is fixed (replay). */
function fakeX402(o: { tx?: string; refuse?: boolean } = {}) {
  const asked: string[] = [];
  let n = 0;
  const x402: X402 = {
    charge: async () => { throw new Error("chat must not use x402 here"); },
    topup: async (_c, tinybar) => {
      asked.push(tinybar);
      if (o.refuse) return Response.json({ error: "payment required" }, { status: 402, headers: { "PAYMENT-REQUIRED": "e30=" } });
      return { payer: "0.0.5123456", tx: o.tx ?? `0.0.5123456@1795125300.${String(++n).padStart(9, "0")}`, amountTinybar: tinybar, asset: "hbar", amountRaw: tinybar, headers: { "PAYMENT-RESPONSE": "e30=" } };
    },
  };
  return { x402, asked };
}

/** Fake Parallax: one SSE answer with the given usage, or HTTP 500. */
function upstream(usage: { prompt_tokens: number; completion_tokens: number } | "fail") {
  return (async () => usage === "fail"
    ? new Response("boom", { status: 500 })
    : new Response(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "ok" } }] })}\n\ndata: ${JSON.stringify({ choices: [], usage: { ...usage, total_tokens: usage.prompt_tokens + usage.completion_tokens } })}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } })) as typeof fetch;
}

async function setup(budgetMc: number | null = null, x = fakeX402()) {
  const db = openDb(":memory:");
  const user = await testAccount(db, cfg);
  const key = createAgentKey(db, signer, user.accountId, "opencode", budgetMc);
  const app = createApp({ cfg, db, signer, directory: testDirectory(cfg, db), x402: x.x402, onComplete: () => {} });
  const bearer = { authorization: `Bearer ${key.token}` };
  const call = (path: string, init: RequestInit = {}, h: Record<string, string> = bearer) =>
    app.request(path, { ...init, headers: { "content-type": "application/json", ...h, ...(init.headers as Record<string, string> ?? {}) } });
  const topup = (hbar: unknown, h: Record<string, string> = bearer) => call("/v1/credits/topup", { method: "POST", body: JSON.stringify({ hbar }) }, h);
  const chat = (maxTokens = 32) => call("/v1/chat/completions", { method: "POST", body: JSON.stringify({ model: model.model_id, messages: [{ role: "user", content: "hello" }], max_tokens: maxTokens, stream: true }) });
  return { db, user, key, app, bearer, call, topup, chat, x };
}

test("rate: 1 testnet HBAR = 10 credits = 10,000 mc, rounded down", () => {
  assert.equal(cfg.net.topup.credits_per_hbar, 10);
  assert.equal(topupMc(cfg.net, HBAR), 10_000);
  assert.equal(topupMc(cfg.net, 5n * HBAR), 50_000);
  assert.equal(topupMc(cfg.net, 150_000_000n), 15_000);
  assert.equal(topupMc(cfg.net, 9_999n), 0);
});

test("GET /v1/credits: the key sees its credits; a session gets 403; no token or a revoked key gets 401", async () => {
  const s = await setup(500_000);
  const res = await s.call("/v1/credits");
  assert.equal(res.status, 200);
  const c = KeyCreditsResponse.parse(await res.json());
  const starter = balance(s.db, s.user.accountId).starter_mc;
  assert.deepEqual({ ...c, topup: undefined }, {
    agent_id: s.key.agent_id, name: "opencode", key_credits_mc: 0, bought_total_mc: 0, account_available_mc: starter,
    cap_mc: 500_000, cap_left_mc: 500_000, spendable_mc: 500_000, spent_mc: 0, topup: undefined,
  });
  assert.equal((await s.call("/v1/credits", {}, s.user.auth)).status, 403);
  assert.equal((await s.call("/v1/credits", {}, {})).status, 401);
  assert.equal((await s.call(`/agents/${s.key.agent_id}`, { method: "DELETE" }, s.user.auth)).status, 200);
  assert.equal((await s.call("/v1/credits")).status, 401);
});

test("POST /v1/credits/topup: pays exactly hbar × 1e8 tinybar, adds 10 credits per HBAR to this key only, writes HCS", async () => {
  const s = await setup();
  const before = balance(s.db, s.user.accountId);
  const res = await s.topup(5);
  assert.equal(res.status, 200, await res.clone().text());
  assert.equal(res.headers.get("PAYMENT-RESPONSE"), "e30=");
  const body = CreditTopupResponse.parse(await res.json());
  assert.deepEqual(s.x.asked, ["500000000"]);
  assert.equal(body.added_mc, 50_000);
  assert.equal(body.credits.key_credits_mc, 50_000);
  assert.equal(body.credits.spendable_mc, 50_000 + before.starter_mc);
  assert.deepEqual(balance(s.db, s.user.accountId), before, "the account balance does not change");
  await s.topup(2.5);
  assert.deepEqual(s.x.asked, ["500000000", "250000000"]);
  assert.equal(keyRow(s.db, s.key.agent_id).key_credits_mc, 75_000);
  const list = await (await s.call("/agents", {}, s.user.auth)).json() as { agents: { key_credits_mc: number; bought_total_mc: number }[] };
  assert.equal(list.agents[0]!.key_credits_mc, 75_000);
  assert.equal(list.agents[0]!.bought_total_mc, 75_000);
  const ev = events(s.db, "credits_purchased");
  assert.equal(ev.length, 2);
  assert.ok(ev[0]!.type === "credits_purchased" && ev[0]!.amount_mc === 50_000 && ev[0]!.amount_tinybar === "500000000" && ev[0]!.agent_id === s.key.agent_id);
});

test("top-up refusals: bad amounts, a session token, no payment, and a replayed transaction credit nothing", async () => {
  const s = await setup();
  for (const hbar of [0, 0.5, 1001, "5", 1e-9]) assert.equal((await s.topup(hbar)).status, 400, `hbar ${hbar}`);
  assert.equal((await s.topup(5, s.user.auth)).status, 403);
  assert.equal((await s.topup(5, {})).status, 401);
  assert.deepEqual(s.x.asked, [], "nothing was charged");

  const unpaid = await setup(null, fakeX402({ refuse: true }));
  const r = await unpaid.topup(5);
  assert.equal(r.status, 402);
  assert.equal(r.headers.get("PAYMENT-REQUIRED"), "e30=");
  assert.equal(keyRow(unpaid.db, unpaid.key.agent_id).key_credits_mc, 0);

  const replay = await setup(null, fakeX402({ tx: "0.0.5123456@1795125300.000000001" }));
  assert.equal((await replay.topup(5)).status, 200);
  const again = await replay.topup(5);
  assert.equal(again.status, 400);
  assert.match(await again.text(), /already credited/);
  assert.equal(keyRow(replay.db, replay.key.agent_id).key_credits_mc, 50_000);
  assert.equal(events(replay.db, "credits_purchased").length, 1);
});

test("spending: bought key credits go first; the account is untouched while they last; HCS says key_mc", async () => {
  const s = await setup();
  await s.topup(5); // 50,000 mc
  const before = balance(s.db, s.user.accountId);
  const original = globalThis.fetch;
  try {
    globalThis.fetch = upstream({ prompt_tokens: 4, completion_tokens: 2 });
    const res = await s.chat();
    assert.equal(res.status, 200);
    await res.text();
    const cost = costMc(cfg.net, model, 4, 2);
    assert.equal(cost, 4900);
    assert.deepEqual(balance(s.db, s.user.accountId), before, "account balance, holds and spent_total unchanged");
    assert.deepEqual(keyRow(s.db, s.key.agent_id), { key_credits_mc: 50_000 - cost, key_held_mc: 0, bought_total_mc: 50_000, key_spent_mc: cost, spent_mc: cost });
    const receipt = Receipt.parse(await (await s.app.request(`/requests/${res.headers.get("x-gpupool-request-id")}`)).json());
    assert.equal(receipt.cost_mc, cost);
    const settled = events(s.db, "request_settled").at(-1)!;
    assert.ok(settled.type === "request_settled" && settled.key_mc === cost && settled.cost_mc === cost);
    const view = KeyCreditsResponse.parse(await (await s.call("/v1/credits")).json());
    assert.equal(view.key_credits_mc, 45_100);
  } finally { globalThis.fetch = original; s.db.close(); }
});

test("spending: when key credits run out mid-request the rest comes from the account, exactly", async () => {
  const s = await setup();
  await s.topup(1); // 10,000 mc
  const before = balance(s.db, s.user.accountId);
  const original = globalThis.fetch;
  try {
    globalThis.fetch = upstream({ prompt_tokens: 4, completion_tokens: 20 });
    const res = await s.chat();
    assert.equal(res.status, 200);
    await res.text();
    const cost = costMc(cfg.net, model, 4, 20); // 36,400
    const after = balance(s.db, s.user.accountId);
    assert.equal(before.starter_mc - after.starter_mc, cost - 10_000);
    assert.equal(after.held_mc, 0);
    assert.equal(after.spent_total_mc - before.spent_total_mc, cost - 10_000, "account spent counts account credits only");
    assert.deepEqual(keyRow(s.db, s.key.agent_id), { key_credits_mc: 0, key_held_mc: 0, bought_total_mc: 10_000, key_spent_mc: 10_000, spent_mc: cost });
    const settled = events(s.db, "request_settled").at(-1)!;
    assert.ok(settled.type === "request_settled" && settled.key_mc === 10_000 && settled.cost_mc === cost);
    // node shares come from the whole cost, as for any credit request
    assert.equal(Object.values(settled.split.nodes).reduce((a, b) => a + b, 0) + settled.split.burn_mc + settled.split.reserve_mc, cost);
  } finally { globalThis.fetch = original; s.db.close(); }
});

test("the cap limits account credits only: a key capped at 0 still spends what was bought for it", async () => {
  const s = await setup(0);
  const original = globalThis.fetch;
  try {
    globalThis.fetch = upstream({ prompt_tokens: 4, completion_tokens: 2 });
    assert.equal((await s.chat()).status, 403, "cap 0 and nothing bought");
    await s.topup(10); // 100,000 mc
    const before = balance(s.db, s.user.accountId);
    const res = await s.chat();
    assert.equal(res.status, 200, await res.clone().text());
    await res.text();
    assert.deepEqual(balance(s.db, s.user.accountId), before);
    assert.equal(keyRow(s.db, s.key.agent_id).key_credits_mc, 100_000 - 4900);
    const view = KeyCreditsResponse.parse(await (await s.call("/v1/credits")).json());
    assert.equal(view.cap_left_mc, 0, "bought spending does not use up the cap");
    assert.equal(view.spendable_mc, 95_100);
  } finally { globalThis.fetch = original; s.db.close(); }
});

test("a failed request gives both holds back: key credits and account unchanged", async () => {
  const s = await setup();
  await s.topup(1);
  const before = balance(s.db, s.user.accountId);
  const original = globalThis.fetch;
  try {
    globalThis.fetch = upstream("fail");
    const res = await s.chat();
    await res.text();
    assert.deepEqual(balance(s.db, s.user.accountId), before);
    assert.deepEqual(keyRow(s.db, s.key.agent_id), { key_credits_mc: 10_000, key_held_mc: 0, bought_total_mc: 10_000, key_spent_mc: 0, spent_mc: 0 });
  } finally { globalThis.fetch = original; s.db.close(); }
});

test("tryHoldForKey is all or nothing: when the account part does not fit, the key part is rolled back", async () => {
  const db = openDb(":memory:");
  const user = await testAccount(db, cfg);
  const key = createAgentKey(db, signer, user.accountId, "k", null);
  creditTopup(db, cfg.net, signer, { agentId: key.agent_id, payer: "0.0.9", tx: "0.0.9@1.1", tinybar: String(HBAR) });
  const account = balance(db, user.accountId).starter_mc;
  assert.equal(tryHoldForKey(db, user.accountId, key.agent_id, 10_000 + account + 1), null);
  assert.equal(keyRow(db, key.agent_id).key_held_mc, 0);
  assert.equal(balance(db, user.accountId).held_mc, 0);
  assert.equal(tryHoldForKey(db, user.accountId, key.agent_id, 12_000), 10_000);
  assert.equal(keyRow(db, key.agent_id).key_held_mc, 10_000);
  assert.equal(balance(db, user.accountId).held_mc, 2_000);
  db.close();
});
