import type { Config } from "../src/config.ts";
import type { Db } from "../src/db.ts";
import { signerFromSeed } from "../src/events.ts";
import { loginOrCreate } from "../src/accounts.ts";
import { issueToken } from "../src/auth.ts";

/** Test-only secrets (not real keys). */
export const TEST_JWT_SECRET = "test-jwt-secret-not-real";
export const TEST_SEED = "11".repeat(32);
export const signer = signerFromSeed(TEST_SEED);

/** A World-verified account (via the real login function) and its session token. */
export async function testAccount(db: Db, cfg: Config, nullifier = `0x${Math.random().toString(16).slice(2).padStart(64, "0")}`) {
  const login = loginOrCreate(db, cfg, signer, nullifier);
  const token = await issueToken(TEST_JWT_SECRET, login.accountId, 3600);
  return { accountId: login.accountId, token, auth: { authorization: `Bearer ${token}` } };
}

export const balance = (db: Db, accountId: string) =>
  db.prepare("SELECT starter_mc, starter_expires_at, earned_mc, held_mc, earned_total_mc, spent_total_mc FROM balances WHERE account_id = ?").get(accountId) as {
    starter_mc: number; starter_expires_at: number; earned_mc: number; held_mc: number; earned_total_mc: number; spent_total_mc: number;
  };
