import { test } from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../src/config.ts";

test("env values pasted with a trailing newline or spaces are trimmed (hosting dashboards)", () => {
  const cfg = loadConfig({ POOL_COORDINATOR_URL: " http://127.0.0.1:3001\n", DATABASE_PATH: ":memory:\r\n", HEDERA_OPERATOR_KEY: `0x${"ab".repeat(32)}\n`, PORT: "10000 " });
  assert.equal(cfg.env.POOL_COORDINATOR_URL, "http://127.0.0.1:3001");
  assert.equal(cfg.env.DATABASE_PATH, ":memory:");
  assert.equal(cfg.env.HEDERA_OPERATOR_KEY, `0x${"ab".repeat(32)}`);
  assert.equal(cfg.env.PORT, 10000);
});
