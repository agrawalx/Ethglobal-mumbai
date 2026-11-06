// Money logic (spec v0.1 §7.3, §8, §10.5) and the mock PoolApi. Run: npm test
(globalThis as any).window = globalThis;
import assert from "node:assert/strict";
const credits = await import("../src/lib/credits.ts");
const fx = await import("../src/data/mock/fixtures.ts");
const { mockApi } = await import("../src/data/mock/index.ts");
const { PaymentRequired } = await import("../src/data/api.ts");
const fmt = await import("../src/lib/format.ts");
let pass = 0;
const ok = (c: boolean, m: string) => { assert.ok(c, m); pass++; console.log("  ✓", m); };
const near = (a: number, b: number, eps = 1e-6) => Math.abs(a - b) < eps;

console.log("credits (§8)");
ok(near(credits.cost(1.75, 412, 256), 592.2), "cost = factor × (out + 0.2 × in): 14B, in 412, out 256 → 592.2");
ok(near(credits.cost(1.0, 100, 100), 120), "8B factor 1.0: in 100, out 100 → 120");
ok(near(credits.holdFor(1.75, 512, 100), 1.75 * (512 + 20)), "hold uses max_tokens as the output");

// §8.3 example: 490 credits, M4 20 layers, M5 9, 4060 11
const route = [
  { node_id: "m4", layers: [11, 31] as [number, number] },
  { node_id: "m5", layers: [31, 40] as [number, number] },
  { node_id: "4060", layers: [0, 11] as [number, number] },
];
const owners: Record<string, string> = { m4: "acc_a", m5: "acc_b", "4060": "acc_c" };
const s = credits.split(490, route, "acc_x", (id) => owners[id]);
ok(near(s.nodes[0].credits, 220.5) && near(s.nodes[1].credits, 99.225) && near(s.nodes[2].credits, 121.275), "§8.3 split: 220.5 / 99.225 / 121.275");
ok(near(s.burn, 24.5) && near(s.reserve, 24.5), "§8.3 split: burn 24.5, reserve 24.5");
ok(near(s.nodes.reduce((a, n) => a + n.credits, 0) + s.burn + s.reserve, 490), "split sums to the cost");
const self = credits.split(490, route, "acc_a", (id) => owners[id]);
ok(self.nodes[0].self && self.nodes[0].credits === 0, "self-request: own node gets 0 credits");
ok(near(self.reserve, 24.5 + 220.5) && near(self.nodes[1].credits, 99.225), "self-request: its share goes to the reserve, others unchanged");
ok(near(self.nodes.reduce((a, n) => a + n.credits, 0) + self.burn + self.reserve, 490), "self-request split still sums to the cost");

const now = Date.now();
const bal = { starter: 100, starter_expires_at: now + 1000, earned: 50, held: 0, earned_total: 50, spent_total: 0 };
const b1 = credits.spend(bal, 80, now);
ok(b1.starter === 20 && b1.earned === 50 && b1.spent_total === 80, "spending uses starter credits first");
const b2 = credits.spend(bal, 130, now);
ok(b2.starter === 0 && b2.earned === 20, "then earned credits");
assert.throws(() => credits.spend(bal, 151, now), credits.InsufficientCredits); pass++; console.log("  ✓ more than starter + earned → InsufficientCredits");
const expired = { ...bal, starter_expires_at: now - 1 };
ok(credits.available(expired, now) === 50, "expired starter credits do not count (§8.2, 14 days)");
assert.throws(() => credits.spend(expired, 60, now), credits.InsufficientCredits); pass++; console.log("  ✓ expired starter credits cannot be spent");
ok(credits.available({ ...bal, held: 30 }, now) === 120, "held credits are not available");
ok(credits.ratio(100, 0) === 100 && credits.ratio(50, 100) === 0.5, "ratio = earned_total / max(spent_total, 1)");

console.log("x402 prices (§7.3)");
ok(credits.x402Price(8, 512) === 0.01 && credits.x402Price(8, 2048) === 0.03, "≤8B: 0.01 / 0.03 HBAR");
ok(credits.x402Price(14, 512) === 0.02 && credits.x402Price(14, 2048) === 0.06, "14B: 0.02 / 0.06 HBAR");
ok(credits.x402Price(0.6, 513) === 0.03, "over 512 tokens uses the 2048 tier");

console.log("units (§10.5: tinybars inside the EVM)");
ok(fmt.fmtHbar(100000000n) === "1.00 HBAR", "fmtHbar(1e8 tinybars) = 1.00 HBAR");
ok(fmt.fmtHbar("2500000") === "0.025 HBAR", "fmtHbar(2,500,000) = 0.025 HBAR");
ok(fmt.toTinybars(0.02) === "2000000", "0.02 HBAR = 2,000,000 tinybars");

console.log("fixtures");
ok(fx.NODES.length === 3 && fx.NODES.every((n) => /^0x[0-9a-f]{40}$/.test(n.node_id)), "3 pool nodes with EVM node ids");
let at = 0;
for (const h of fx.POOL.layer_map) { assert.equal(h.layers[0], at); at = h.layers[1]; }
ok(at === 40, "layer map covers [0,40) of Qwen3-14B contiguously");
ok(fx.POOL.layer_map.map((h) => h.layers[1] - h.layers[0]).join() === "11,20,9", "layers 11 / 20 / 9 (4060 / M4 / M5)");
ok(fx.NODES.every((n) => near(n.reliability, +(0.7 * n.success_rate! + 0.3 * n.uptime_rate!).toFixed(3))), "reliability = 0.7 × success + 0.3 × uptime");
ok(fx.POOL.reliability === Math.min(...fx.NODES.map((n) => n.reliability)), "pool reliability = lowest node");
ok(fx.RECEIPTS.length === 25 && fx.RECEIPTS.filter((r) => r.pay_type === "x402").length === 8, "25 receipts, 8 paid with x402");
ok(fx.RECEIPTS.filter((r) => r.pay_type === "credits" && r.status === "ok").every((r) => near(credits.cost(1.75, r.in_tokens, r.out_tokens), r.cost, 0.01)), "credit receipts follow the cost formula");
ok(fx.RECEIPTS.filter((r) => r.split).every((r) => near(r.split!.nodes.reduce((a, n) => a + n.credits, 0) + r.split!.burn + r.split!.reserve, r.cost)), "every split sums to its cost");
const failed = fx.RECEIPTS.filter((r) => r.status === "failed");
ok(failed.length === 1 && failed[0].cost === 0 && failed[0].hcs_seq === null, "failed request: user pays nothing, no ledger event");
const L = fx.LEDGER;
ok(L.every((e, i) => e.hcs_seq === fx.hcsSeqStart + i), "ledger HCS seq is contiguous");
ok(new Set(L.map((e) => e.type)).size === 8, "all 8 ledger event types are present");
ok(fx.RECEIPTS.filter((r) => r.status === "ok").every((r) => L.some((e) => e.hcs_seq === r.hcs_seq && e.payload.req_id === r.req_id)), "each ok receipt points at its HCS event");
for (const e of fx.EPOCHS) {
  const sum = fx.PAYOUTS.filter((p) => p.epoch === e.epoch).reduce((a, p) => a + Number(p.amount_tinybar), 0);
  assert.equal(sum, Number(e.total_tinybar));
}
ok(true, "epoch payouts sum to the epoch total");
ok(fx.EPOCHS[0].status === "open" && fx.EPOCHS[0].end_ts > Date.now(), "current epoch is open");
ok(fx.EPOCHS.filter((e) => e.status === "posted").every((e) => fx.PAYOUTS.some((p) => p.epoch === e.epoch)), "each posted epoch has payouts");
const x402InEpoch11 = fx.RECEIPTS.filter((r) => r.pay_type === "x402" && r.ts >= fx.EPOCHS[1].start_ts && r.ts < fx.EPOCHS[1].end_ts).reduce((a, r) => a + Number(r.x402_amount), 0);
ok(Math.abs(Number(fx.EPOCHS[1].total_tinybar) - x402InEpoch11 * 0.8) <= 3, "epoch total = 80% of its x402 income (§10.5)");

console.log("mock api: login (§6)");
await assert.rejects(mockApi.auth.verify({ simulate: "invalid" })); pass++; console.log("  ✓ invalid proof is rejected");
const first = await mockApi.auth.verify({ simulate: "new" });
ok(first.created && first.me.balance.starter === 10_000, "new human: account created with 10,000 starter credits");
const again = await mockApi.auth.verify({ simulate: "new" });
ok(!again.created && again.me.account_id === first.me.account_id, "same human again: logs in, no new account");
ok(fx.LEDGER.filter((e) => e.type === "starter_grant" && e.payload.account === first.me.account_id).length === 1, "starter credits granted once");
const token = first.token;

console.log("mock api: chat (§5.3)");
await assert.rejects(async () => { for await (const _ of mockApi.chat({ model: fx.POOL_MODEL, messages: [{ role: "user", content: "hi" }], max_tokens: 512 }, null, new AbortController().signal)) void _; }, PaymentRequired);
pass++; console.log("  ✓ no session → 402 (x402)");
const msgs = [{ role: "user" as const, content: "how does the pool split layers?" }];
let rid: string | undefined;
let routeSeen = 0;
const seqBefore = fx.LEDGER.at(-1)!.hcs_seq!;
for await (const c of mockApi.chat({ model: fx.POOL_MODEL, messages: msgs, max_tokens: 40 }, token, new AbortController().signal)) {
  if (c.route) routeSeen = c.route.length;
  if (c.done) rid = c.receipt_id;
}
const rc = (await mockApi.request(rid!))!;
ok(routeSeen === 3 && rc.route.length === 3, "route has 3 hops");
ok(rc.out_tokens === 40 && near(rc.cost, +credits.cost(1.75, credits.estimateTokens(msgs), 40).toFixed(2)), "cost follows the formula (out capped at max_tokens)");
const me1 = await mockApi.me(token);
ok(near(me1.balance.starter, 10_000 - rc.cost) && me1.balance.held === 0, "balance = 10,000 − cost, hold released");
ok(fx.LEDGER.at(-1)!.type === "request_settled" && fx.LEDGER.at(-1)!.hcs_seq === seqBefore + 1 && rc.hcs_seq === seqBefore + 1, "request_settled written with the next HCS seq");
ok(near(rc.split!.nodes.reduce((a, n) => a + n.credits, 0), rc.cost * 0.9), "90% to the nodes");
const ctl = new AbortController();
let n = 0;
let stopId: string | undefined;
for await (const c of mockApi.chat({ model: fx.POOL_MODEL, messages: msgs, max_tokens: 512 }, token, ctl.signal)) {
  if (c.delta.trim()) n++;
  if (n === 3 && !ctl.signal.aborted) ctl.abort();
  if (c.done) stopId = c.receipt_id;
}
const stopped = (await mockApi.request(stopId!))!;
const me2 = await mockApi.me(token);
ok(stopped.out_tokens >= 3 && stopped.out_tokens <= 6 && me2.balance.held === 0, "Stop settles only the tokens served and releases the hold");
ok((await mockApi.myRequests(token)).length === 2, "my receipts list has both requests");

console.log("mock api: nodes (§4, §6.3)");
const id = (k: string) => `0x${k.repeat(40)}`;
await assert.rejects(mockApi.registerNode(token, { node_id: "nope", sig: "s", payout_address: fx.DEMO_OWNER })); pass++; console.log("  ✓ bad node id is rejected");
for (const k of ["a", "b", "c"]) await mockApi.registerNode(token, { node_id: id(k), sig: "0xsig", gpu: "Apple M4", mem_gb: 16, payout_address: fx.DEMO_OWNER });
const me3 = await mockApi.me(token);
ok(me3.nodes.length === 3 && me3.payout_address === fx.DEMO_OWNER && me3.nodes.every((x) => x.reliability === 0.8), "3 nodes linked, new nodes start at 0.8, payout address set");
await assert.rejects(mockApi.registerNode(token, { node_id: id("d"), sig: "0xsig", payout_address: fx.DEMO_OWNER }), /at most 3/); pass++; console.log("  ✓ a 4th node is refused");
await assert.rejects(mockApi.registerNode(token, { node_id: fx.NODE.rex.node_id, sig: "0xsig", payout_address: fx.DEMO_OWNER }), /another account/); pass++; console.log("  ✓ someone else's node is refused");

console.log("mock api: network (§11)");
const net = await mockApi.network();
ok(net.pools.length === 1 && net.pools[0].status === "ready", "one ready pool");
ok((await mockApi.models()).find((m) => m.model.model_id === fx.POOL_MODEL)!.served && !(await mockApi.models()).find((m) => m.model.model_id === "Qwen/Qwen3-8B")!.served, "14B served, 8B has no live pool");
console.log("  ·", (globalThis as any).__gpupoolExpireNow("Mika"));
const net2 = await mockApi.network();
ok(!net2.nodes.some((x) => x.nickname === "Mika") && net2.pools[0].status === "forming", "stopped node disappears; pool is no longer ready");
ok(!(await mockApi.models()).find((m) => m.model.model_id === fx.POOL_MODEL)!.served, "model is not served while the pool is not ready");
await assert.rejects(async () => { for await (const _ of mockApi.chat({ model: fx.POOL_MODEL, messages: msgs, max_tokens: 40 }, token, new AbortController().signal)) void _; }, /paid nothing/);
pass++; console.log("  ✓ no pool → 503, user pays nothing");
console.log("  ·", (globalThis as any).__gpupoolReplug("Mika"));
ok((await mockApi.network()).pools[0].status === "ready", "replug → pool ready again");

console.log("mock api: ledger, mirror, payouts (§8.6, §10.5)");
const led = await mockApi.ledger({ type: "x402_payment" });
ok(led.length === 8 && led.every((e) => e.type === "x402_payment") && led[0].ts >= led[1].ts, "ledger filter by type, newest first");
const seq = fx.LEDGER[5].hcs_seq!;
ok((await mockApi.mirror(fx.HCS_TOPIC, seq)).found && !(await mockApi.mirror("0.0.1", seq)).found, "mirror check finds HCS messages on the ledger topic only");
const po = await mockApi.payouts(fx.DEMO_OWNER);
const claimable = po.payouts.find((p) => p.epoch === 11 && !p.claimed)!;
ok(!!claimable && po.payouts.some((p) => p.epoch === 10 && p.claimed), "demo wallet: epoch 11 claimable, epoch 10 claimed");
const { tx } = await mockApi.claim(claimable);
ok(/^0\.0\.\d+@\d+\.\d+$/.test(tx) && fx.LEDGER.at(-1)!.type === "payout_claimed", "claim returns a Hedera tx id and writes payout_claimed");
await assert.rejects(mockApi.claim(claimable), /Already claimed/); pass++; console.log("  ✓ claim twice is refused");
await assert.rejects(mockApi.claim({ ...claimable, epoch: 12 }), /not posted/); pass++; console.log("  ✓ open epoch cannot be claimed");

console.log(`\n${pass} checks passed`);
process.exit(0);
