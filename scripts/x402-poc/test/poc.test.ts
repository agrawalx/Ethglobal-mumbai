import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createPocApp, readEnv } from "../src/server.ts";
import { hashscanTxUrl, loadNetConfig, priceTinybar } from "../src/price.ts";

const FEE_PAYER = "0.0.9185802";
let facilitator: Server;
let facilitatorUrl = "";

// Fake facilitator: only GET /supported (what the middleware syncs at start). No network, no money.
before(async () => {
  facilitator = createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.url?.endsWith("/supported")) {
      res.end(JSON.stringify({ kinds: [{ x402Version: 2, scheme: "exact", network: "hedera:testnet", extra: { feePayer: FEE_PAYER } }], extensions: [], signers: {} }));
    } else {
      res.statusCode = 404;
      res.end("{}");
    }
  });
  await new Promise<void>((r) => facilitator.listen(0, "127.0.0.1", r));
  facilitatorUrl = `http://127.0.0.1:${(facilitator.address() as AddressInfo).port}`;
});
after(() => facilitator.close());

test("price comes from the shared config tiers (tinybar strings)", () => {
  const cfg = loadNetConfig();
  assert.equal(priceTinybar(cfg, "Qwen/Qwen3-14B-FP8", 512), "2000000");
  assert.equal(priceTinybar(cfg, "Qwen/Qwen3-14B-FP8", 513), "6000000");
  assert.equal(priceTinybar(cfg, "Qwen/Qwen3-8B-FP8", 100), "1000000");
  assert.throws(() => priceTinybar(cfg, "Qwen/Qwen3-14B-FP8", 4096), /above the last tier/);
});

test("HashScan link from a Hedera tx ID", () => {
  assert.equal(hashscanTxUrl("0.0.9185802@1793912400.123456789"), "https://hashscan.io/testnet/transaction/0.0.9185802-1793912400-123456789");
  assert.throws(() => hashscanTxUrl("0xabc"));
});

test("env: missing keys and EVM payTo are rejected", () => {
  assert.throws(() => readEnv({}), /X402_FACILITATOR_URL, X402_PAY_TO/);
  assert.throws(() => readEnv({ X402_FACILITATOR_URL: "http://x", X402_PAY_TO: "0xabc" }), /0\.0\.x/);
});

test("unpaid GET /echo → 402 with HBAR requirements in the PAYMENT-REQUIRED header", async () => {
  const app = createPocApp(readEnv({ X402_FACILITATOR_URL: facilitatorUrl, X402_PAY_TO: "0.0.1234" }));
  const r = await app.request("/echo?msg=hi", { headers: { accept: "application/json" } });
  assert.equal(r.status, 402);
  const header = r.headers.get("PAYMENT-REQUIRED");
  assert.ok(header, "PAYMENT-REQUIRED header missing");
  const req = JSON.parse(Buffer.from(header!, "base64").toString("utf8"));
  assert.equal(req.x402Version, 2);
  assert.equal(req.accepts.length, 1);
  const a = req.accepts[0];
  assert.deepEqual(
    { scheme: a.scheme, network: a.network, asset: a.asset, amount: a.amount, payTo: a.payTo, feePayer: a.extra?.feePayer },
    { scheme: "exact", network: "hedera:testnet", asset: "0.0.0", amount: "2000000", payTo: "0.0.1234", feePayer: FEE_PAYER },
  );
  // Free route still works.
  assert.equal((await app.request("/healthz")).status, 200);
});
