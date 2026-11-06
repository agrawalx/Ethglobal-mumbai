#!/usr/bin/env node
/**
 * End-to-end check of the docs-page flow over real HTTP (docs/DOCS-API-KEYS.md):
 *  sign in → "Generate API key" (POST /agents) → OpenAI-compatible use with the key (OpenCode-style
 *  tools) → credits overview (/me + /agents, own keys only) → HBAR top-up with the real agent-client
 *  CLI (x402, a signed Hedera transfer) → bought credits spent first.
 * Fake Parallax and a fake x402 facilitator on localhost: no real HBAR moves, no network needed.
 *   pnpm e2e:docs
 */
import { createServer, type Server, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { serve } from "@hono/node-server";
import { PrivateKey } from "@x402/hedera";
import { loadConfig } from "../src/config.ts";
import { openDb } from "../src/db.ts";
import { createApp } from "../src/app.ts";
import { createX402 } from "../src/x402.ts";
import { loginOrCreate } from "../src/accounts.ts";
import { issueToken } from "../src/auth.ts";
import { signerFromSeed } from "../src/events.ts";
import { testDirectory } from "../test/helpers.ts";

const execFileP = promisify(execFile);
const AGENT_CLIENT = fileURLToPath(new URL("../../agent-client", import.meta.url));
const body = (req: IncomingMessage) => new Promise<string>((r) => { let s = ""; req.on("data", (d) => (s += d)); req.on("end", () => r(s)); });
const listen = (s: Server) => new Promise<number>((r) => s.listen(0, "127.0.0.1", () => r((s.address() as AddressInfo).port)));
const step = (m: string) => console.log(`\n▶ ${m}`);
const okk = (m: string) => console.log(`  ✓ ${m}`);

// Fake Parallax: plain answer, or a Qwen3 <tool_call> when tools are present (OpenCode-like).
const parallax = createServer(async (req, res) => {
  const b = JSON.parse(await body(req));
  const tool = JSON.stringify(b).includes("<tools>") && !JSON.stringify(b).includes("tool_response");
  const text = tool ? '<tool_call>{"name":"read","arguments":{"filePath":"README.md"}}</tool_call>' : "Hello from the pool.";
  res.setHeader("content-type", "text/event-stream");
  res.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: text } }] })}\n\ndata: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 400, completion_tokens: 30, total_tokens: 430 } })}\n\ndata: [DONE]\n\n`);
});
// Fake facilitator: checks the signed Hedera transfer payload arrives, settles with a fresh tx id.
const verified: any[] = [];
let n = 0;
const facilitator = createServer(async (req, res) => {
  const b = await body(req);
  res.setHeader("content-type", "application/json");
  if (req.url?.endsWith("/supported")) return res.end(JSON.stringify({ kinds: [{ x402Version: 2, scheme: "exact", network: "hedera:testnet", extra: { feePayer: "0.0.9185802" } }], extensions: [], signers: {} }));
  const p = JSON.parse(b);
  if (req.url?.endsWith("/verify")) { verified.push(p); return res.end(JSON.stringify({ isValid: true, payer: "0.0.7777777" })); }
  if (req.url?.endsWith("/settle")) return res.end(JSON.stringify({ success: true, payer: "0.0.7777777", transaction: `0.0.7777777@1795125300.${String(++n).padStart(9, "0")}`, network: "hedera:testnet" }));
  res.statusCode = 404; res.end("{}");
});
const pPort = await listen(parallax);
const fPort = await listen(facilitator);

const SEED = "22".repeat(32);
const cfg = loadConfig({ DATABASE_PATH: join(mkdtempSync(join(tmpdir(), "gp-e2e-")), "g.db"), POOL_COORDINATOR_URL: `http://127.0.0.1:${pPort}`, JWT_SECRET: "e2e-secret", GATEWAY_SIGNING_KEY: SEED, TOOLS_MODE: "emulate" });
const db = openDb(cfg.env.DATABASE_PATH);
const signer = signerFromSeed(SEED);
const x402 = createX402({ cfg: cfg.net, facilitatorUrl: `http://127.0.0.1:${fPort}`, network: "hedera:testnet", payTo: "0.0.11331600" });
const app = createApp({ cfg, db, signer, directory: testDirectory(cfg, db), x402, onComplete: () => {} });
const server = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" }) as unknown as Server;
await new Promise((r) => server.once("listening", r));
const GW = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
const j = async (path: string, init: RequestInit = {}, auth?: string) => {
  const r = await fetch(`${GW}${path}`, { ...init, headers: { "content-type": "application/json", ...(auth ? { authorization: `Bearer ${auth}` } : {}), ...(init.headers ?? {}) } });
  return { status: r.status, headers: r.headers, body: await r.text().then((t) => { try { return JSON.parse(t); } catch { return t; } }) };
};

try {
  step("User signs in (World login simulated: same account + session token the World flow returns)");
  const alice = loginOrCreate(db, cfg, signer, "dev:alice");
  const bob = loginOrCreate(db, cfg, signer, "dev:bob");
  const aliceSession = await issueToken("e2e-secret", alice.accountId, 3600);
  const bobSession = await issueToken("e2e-secret", bob.accountId, 3600);
  const me0 = await j("/me", {}, aliceSession);
  assert.equal(me0.status, 200);
  okk(`GET /me → starter ${me0.body.balance.starter_mc / 1000} cr, earned ${me0.body.balance.earned_mc / 1000} cr`);

  step('Docs: click "Generate API key" → POST /agents (session)');
  assert.equal((await j("/agents", { method: "POST", body: JSON.stringify({ name: "opencode" }) })).status, 401);
  okk("not signed in → 401 (docs must ask the user to sign in first)");
  const gen = await j("/agents", { method: "POST", body: JSON.stringify({ name: "opencode" }) }, aliceSession);
  assert.equal(gen.status, 200, JSON.stringify(gen.body));
  const KEY = gen.body.token as string;
  assert.match(KEY, /^gpa_agt_[A-Za-z0-9]+_[0-9a-f]{64}$/);
  okk(`200 → token ${KEY.slice(0, 18)}… (shown once), key_credits ${gen.body.key_credits_mc}, cap ${gen.body.budget_mc}`);

  step("OpenAI-compatible: models + a streaming chat with the key, like OpenCode");
  const models = await j("/v1/models", {}, KEY);
  okk(`GET /v1/models → ${models.status} (${Array.isArray(models.body?.data) ? models.body.data.map((m: any) => m.id).join(", ") || "no Arkiv catalog in this harness" : models.status})`);
  const chat = await j("/v1/chat/completions", { method: "POST", body: JSON.stringify({ model: "Qwen/Qwen3-14B-FP8", stream: true, max_tokens: 32000,
    tools: [{ type: "function", function: { name: "read", description: "Read a file", parameters: { type: "object", properties: { filePath: { type: "string" } } } } }],
    messages: [{ role: "system", content: "You are opencode." }, { role: "user", content: "Read README.md" }] }) }, KEY);
  assert.equal(chat.status, 200, String(chat.body));
  assert.match(String(chat.body), /"tool_calls"/);
  assert.match(String(chat.body), /"finish_reason":"tool_calls"/);
  okk(`200 stream with OpenAI tool_calls; x-gpupool-max-tokens=${chat.headers.get("x-gpupool-max-tokens")} (client asked 32000)`);
  const me1 = await j("/me", {}, aliceSession);
  const spent1 = me0.body.balance.starter_mc - me1.body.balance.starter_mc;
  assert.ok(spent1 > 0);
  okk(`no bought credits yet → charged ${spent1 / 1000} cr from the account (actual tokens only)`);

  step("Docs credits overview: GET /me + GET /agents (session) — only this user's keys");
  const list = await j("/agents", {}, aliceSession);
  assert.equal(list.body.agents.length, 1);
  okk(`alice sees 1 key: spent ${list.body.agents[0].spent_mc / 1000} cr, bought left ${list.body.agents[0].key_credits_mc / 1000} cr`);
  const bobList = await j("/agents", {}, bobSession);
  assert.equal(bobList.body.agents.length, 0);
  assert.equal((await j(`/agents/${gen.body.agent_id}/requests`, {}, bobSession)).status, 404);
  okk("bob (another user id) sees 0 keys and gets 404 on alice's key usage");
  assert.equal((await j("/v1/credits", {}, aliceSession)).status, 403);
  okk("GET /v1/credits with a session → 403 (key only); docs use /me + /agents");

  step("Top-up with the real agent-client CLI: x402, testnet HBAR, 2 HBAR → +20 credits on this key");
  const throwaway = PrivateKey.generateECDSA().toStringDer();
  const env = { ...process.env, GATEWAY_URL: GW, GPUPOOL_API_KEY: KEY, AGENT_ACCOUNT_ID: "0.0.7777777", AGENT_PRIVATE_KEY: throwaway, HEDERA_NETWORK: "testnet" };
  const cli = (await execFileP(process.execPath, ["src/topup.ts", "--hbar", "2"], { cwd: AGENT_CLIENT, env, encoding: "utf8", timeout: 60_000 })).stdout;
  console.log(cli.split("\n").map((l) => `    | ${l}`).join("\n"));
  assert.equal(verified.length, 1, "facilitator got one signed payment");
  const req = verified[0].paymentRequirements ?? verified[0].requirements;
  okk(`facilitator /verify got a signed Hedera transfer for amount ${req?.amount} tinybar, asset ${req?.asset}, payTo ${req?.payTo}`);
  assert.equal(req?.amount, "200000000");
  const after = await j("/v1/credits", {}, KEY);
  assert.equal(after.body.key_credits_mc, 20_000);
  okk(`GET /v1/credits (key) → bought ${after.body.key_credits_mc / 1000} cr, spendable ${after.body.spendable_mc / 1000} cr`);
  const me2 = await j("/me", {}, aliceSession);
  assert.deepEqual(me2.body.balance, me1.body.balance);
  okk("account balance unchanged by the top-up (credits belong to the key)");

  step("Next prompt spends the bought credits first");
  const chat2 = await j("/v1/chat/completions", { method: "POST", body: JSON.stringify({ model: "Qwen/Qwen3-14B-FP8", stream: true, messages: [{ role: "user", content: "hi" }] }) }, KEY);
  assert.equal(chat2.status, 200);
  const k2 = (await j("/agents", {}, aliceSession)).body.agents[0];
  const me3 = await j("/me", {}, aliceSession);
  const rcpt = await j(`/requests/${chat2.headers.get("x-gpupool-request-id")}`);
  const cost = rcpt.body.cost_mc as number; // 400 in / 30 out at 1.75 = 192.5 cr, more than the 20 bought
  assert.equal(k2.key_credits_mc, 0);
  assert.equal(me2.body.balance.starter_mc - me3.body.balance.starter_mc, cost - 20_000);
  const settled = (await j("/ledger/events?limit=5")).body.events.find((e: any) => e.event.type === "request_settled" && e.event.req_id === rcpt.body.req_id);
  assert.equal(settled.event.key_mc, 20_000);
  okk(`cost ${cost / 1000} cr = ${20} cr from the key's bought credits + ${(cost - 20_000) / 1000} cr from the account (HCS key_mc=${settled.event.key_mc})`);

  step("Ledger");
  const ev = await j("/ledger/events?limit=20");
  const types = ev.body.events.map((e: any) => e.event.type);
  assert.ok(types.includes("credits_purchased") && types.includes("agent_key_created"));
  okk(`events: ${[...new Set(types)].join(", ")}`);
  console.log("\nALL CHECKS PASSED");
  process.exitCode = 0;
} finally {
  server.close(); parallax.close(); facilitator.close(); db.close();
}
