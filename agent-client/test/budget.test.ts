import { test } from "node:test";
import assert from "node:assert/strict";
import { canAfford, hashscanTxUrl, hbarToTinybar, loadNetConfig, portalKeyKind, priceTinybar } from "../src/budget.ts";

test("price tiers match the shared config (SPEC §7.3)", () => {
  const cfg = loadNetConfig();
  assert.equal(priceTinybar(cfg, "Qwen/Qwen3-14B-FP8", 128), 2_000_000n);
  assert.equal(priceTinybar(cfg, "Qwen/Qwen3-14B-FP8", 1024), 6_000_000n);
  assert.equal(priceTinybar(cfg, "Qwen/Qwen3-8B-FP8", 512), 1_000_000n);
  assert.throws(() => priceTinybar(cfg, "Qwen/Qwen3-14B-FP8", 4096), /last tier/);
});

test("HBAR → tinybar is exact", () => {
  assert.equal(hbarToTinybar("1"), 100_000_000n);
  assert.equal(hbarToTinybar("0.05"), 5_000_000n);
  assert.equal(hbarToTinybar("0.00000001"), 1n);
  assert.throws(() => hbarToTinybar("0.000000001"));
  assert.throws(() => hbarToTinybar("-1"));
});

test("budget cap: stop before a payment would exceed the budget", () => {
  const budget = hbarToTinybar("0.05"); // 5,000,000
  const price = 2_000_000n;
  let spent = 0n;
  let paid = 0;
  for (let i = 0; i < 5; i++) {
    if (!canAfford(spent, price, budget)) break;
    spent += price;
    paid++;
  }
  assert.equal(paid, 2);
  assert.equal(spent, 4_000_000n);
  assert.equal(canAfford(4_000_000n, 1_000_000n, budget), true); // exactly at the cap is allowed
});

test("HashScan link", () => {
  assert.equal(hashscanTxUrl("0.0.9185802@1793929496.997341480"), "https://hashscan.io/testnet/transaction/0.0.9185802-1793929496-997341480");
});

test("Portal keys: DER carries its type; raw hex needs ecdsa or ed25519", () => {
  assert.equal(portalKeyKind("302e020100300506032b657004220420" + "ab".repeat(32)), "der");
  assert.equal(portalKeyKind("3030020100300706052b8104000a04220420" + "ab".repeat(32)), "der");
  assert.equal(portalKeyKind("0x" + "ab".repeat(32)), "ecdsa");
  assert.equal(portalKeyKind("ab".repeat(32), "ed25519"), "ed25519");
  assert.throws(() => portalKeyKind("ab".repeat(32), "rsa"));
  assert.throws(() => portalKeyKind("not-a-key"));
});

test("top-up rate in shared config: 1 HBAR = 10 credits", () => {
  assert.equal(loadNetConfig().topup.credits_per_hbar, 10);
});
