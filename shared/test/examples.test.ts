import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import type { z } from "zod";
import * as S from "../src/index.ts";

const dir = new URL("../examples/", import.meta.url);
const load = (name: string): unknown => JSON.parse(readFileSync(new URL(name, dir), "utf8"));

/** Every example file and the schema it must satisfy. */
const EXAMPLES: Record<string, z.ZodType> = {
  "error-response.json": S.ErrorResponse,
  "chat-completion-request.json": S.ChatCompletionRequest,
  "chat-completion-response.json": S.ChatCompletionResponse,
  "models-response.json": S.ModelsResponse,
  "world-verify-response.json": S.WorldVerifyResponse,
  "rp-signature-response.json": S.RpSignatureResponse,
  "session-claims.json": S.SessionClaims,
  "me-response.json": S.MeResponse,
  "node-register-request.json": S.NodeRegisterRequest,
  "node-register-response.json": S.NodeRegisterResponse,
  "node-heartbeat.json": S.NodeHeartbeat,
  "ok-response.json": S.OkResponse,
  "heartbeat-response.json": S.HeartbeatResponse,
  "pool-state-response.json": S.PoolStateResponse,
  "pool-plan-response.json": S.PoolPlanResponse,
  "receipt.json": S.Receipt,
  "network-response.json": S.NetworkResponse,
  "ledger-events-response.json": S.LedgerEventsResponse,
  "payouts-response.json": S.PayoutsResponse,
  "arkiv-node.json": S.ArkivNode,
  "arkiv-pool.json": S.ArkivPool,
  "arkiv-model.json": S.ArkivModel,
  "arkiv-account-stats.json": S.ArkivAccountStats,
  "merkle-leaf.json": S.MerkleLeaf,
  "payout-proof.json": S.PayoutProof,
  "payout-route.json": S.PayoutRoute,
  "hcs-account-created.json": S.AccountCreatedEvent,
  "hcs-starter-grant.json": S.StarterGrantEvent,
  "hcs-request-settled.json": S.RequestSettledEvent,
  "hcs-x402-payment.json": S.X402PaymentEvent,
  "hcs-credits-expired.json": S.CreditsExpiredEvent,
  "hcs-payout-address-set.json": S.PayoutAddressSetEvent,
  "hcs-epoch-closed.json": S.EpochClosedEvent,
  "hcs-payout-claimed.json": S.PayoutClaimedEvent,
  "hcs-verification-result.json": S.VerificationResultEvent,
  "hcs-verification-appeal.json": S.VerificationAppealEvent,
  "hcs-verification-final.json": S.VerificationFinalEvent,
  "hcs-hardware-challenge.json": S.HardwareChallengeEvent,
  "hcs-verification-canary.json": S.VerificationCanaryEvent,
  "hcs-credits-clawed-back.json": S.CreditsClawedBackEvent,
  "hcs-account-banned.json": S.AccountBannedEvent,
  "hcs-availability-reward.json": S.AvailabilityRewardEvent,
  "hcs-agent-key-created.json": S.AgentKeyCreatedEvent,
  "agent-key-create-response.json": S.AgentKeyCreateResponse,
  "agent-key-list-response.json": S.AgentKeyListResponse,
  "collusion-flags-response.json": S.CollusionFlagsResponse,
};

test("every example file has a schema, and every schema entry has a file", () => {
  const files = readdirSync(dir).filter((f) => f.endsWith(".json")).sort();
  assert.deepEqual(files, Object.keys(EXAMPLES).sort());
});

for (const [file, schema] of Object.entries(EXAMPLES)) {
  test(`example ${file} matches its schema`, () => {
    const r = schema.safeParse(load(file));
    assert.ok(r.success, r.success ? "" : JSON.stringify(r.error.issues, null, 2));
  });
}

test("HCS examples parse as LedgerEvent and stay under 1 KB", () => {
  const seen = new Set<string>();
  for (const file of Object.keys(EXAMPLES).filter((f) => f.startsWith("hcs-"))) {
    const raw = readFileSync(new URL(file, dir), "utf8");
    const ev = S.LedgerEvent.parse(JSON.parse(raw));
    seen.add(ev.type);
    assert.ok(Buffer.byteLength(JSON.stringify(JSON.parse(raw))) < 1024, `${file} >= 1 KB`);
  }
  assert.deepEqual([...seen].sort(), [...S.LEDGER_EVENT_TYPES].sort());
});

test("ledger event types are exactly SPEC §8.6", () => {
  assert.deepEqual([...S.LEDGER_EVENT_TYPES].sort(), [
    "account_banned",
    "account_created",
    "agent_key_created",
    "availability_reward",
    "credits_clawed_back",
    "credits_expired",
    "epoch_closed",
    "payout_address_set",
    "payout_claimed",
    "request_settled",
    "starter_grant",
    "hardware_challenge",
    "verification_appeal",
    "verification_canary",
    "verification_final",
    "verification_result",
    "x402_payment",
  ].sort());
});

test("config file matches GpupoolConfig", () => {
  const raw = JSON.parse(readFileSync(new URL("../config/gpupool.config.json", import.meta.url), "utf8"));
  const cfg = S.GpupoolConfig.parse(raw);
  for (const m of cfg.models) {
    const tiers = m.x402_prices.map((t) => t.max_tokens);
    assert.deepEqual(tiers, [...tiers].sort((a, b) => a - b), `${m.model_id} tiers not ascending`);
  }
});

test("request_settled example: split parts sum exactly to cost", () => {
  const ev = S.RequestSettledEvent.parse(load("hcs-request-settled.json"));
  const nodes = Object.values(ev.split.nodes).reduce((a, b) => a + b, 0);
  assert.equal(nodes + ev.split.burn_mc + ev.split.reserve_mc, ev.cost_mc);
});

test("epoch_closed example: payouts sum to total", () => {
  const ev = S.EpochClosedEvent.parse(load("hcs-epoch-closed.json"));
  const sum = (ev.payouts ?? []).reduce((a, p) => a + BigInt(p.amount_tinybar), 0n);
  assert.equal(sum, BigInt(ev.total_tinybar));
});

test("failure path: bad inputs are rejected", () => {
  assert.equal(S.LayerRange.safeParse([29, 29]).success, false);
  assert.equal(S.Millicredits.safeParse(1.5).success, false);
  assert.equal(S.Tinybar.safeParse("0.01").success, false);
  assert.equal(S.LedgerEvent.safeParse({ ...(load("hcs-account-created.json") as object), type: "minted" }).success, false);
  // logprobs is stripped, never forwarded to Parallax
  const req = S.ChatCompletionRequest.parse({ ...(load("chat-completion-request.json") as object), logprobs: true });
  assert.equal("logprobs" in req, false);
});

test("canonical JSON: sorted keys, no whitespace, same bytes as Python json.dumps(sort_keys, separators, ensure_ascii=False)", () => {
  const obj = { z: 1, a: { y: [3, { b: "é→✓", a: null }], x: 5.6 }, m: "q\"uote", n: true, k: -0.25, big: 1793912345123 };
  const ts = S.canonicalJson(obj);
  assert.equal(ts, '{"a":{"x":5.6,"y":[3,{"a":null,"b":"é→✓"}]},"big":1793912345123,"k":-0.25,"m":"q\\"uote","n":true,"z":1}');
  const py = execFileSync("python3", ["-c", "import json,sys; sys.stdout.write(json.dumps(json.loads(sys.stdin.read()), sort_keys=True, separators=(',', ':'), ensure_ascii=False))"], { input: JSON.stringify(obj) }).toString("utf8");
  assert.equal(ts, py);
});

test("config models have num_layers (Qwen3-14B = 40, Qwen3-8B = 36)", () => {
  const cfg = S.GpupoolConfig.parse(JSON.parse(readFileSync(new URL("../config/gpupool.config.json", import.meta.url), "utf8")));
  assert.equal(cfg.models.find((m) => m.model_id === "Qwen/Qwen3-14B-FP8")?.num_layers, 40);
  assert.equal(cfg.models.find((m) => m.model_id === "Qwen/Qwen3-8B-FP8")?.num_layers, 36);
});
