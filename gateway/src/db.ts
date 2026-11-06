import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";

/**
 * SQLite schema (SPEC §8.7). Credits are integer millicredits (`*_mc`), HBAR amounts are
 * tinybar decimal strings, times are Unix ms. No migrations (dev phase): when SCHEMA_VERSION
 * changes, delete the database file and restart.
 */
export const SCHEMA_VERSION = 2;

export const TABLES = [
  "accounts",
  "balances",
  "nodes",
  "node_reliability",
  "requests",
  "ledger_events",
  "epochs",
  "epoch_payouts",
  "transcripts",
] as const;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS accounts (
  id               TEXT PRIMARY KEY,                 -- acc_…
  world_nullifier  TEXT NOT NULL UNIQUE,             -- never leaves the gateway
  payout_address   TEXT,                             -- lowercase EVM address
  created_at       INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS balances (
  account_id          TEXT PRIMARY KEY REFERENCES accounts(id),
  starter_mc          INTEGER NOT NULL DEFAULT 0 CHECK (starter_mc >= 0),
  starter_expires_at  INTEGER,
  earned_mc           INTEGER NOT NULL DEFAULT 0 CHECK (earned_mc >= 0),
  held_mc             INTEGER NOT NULL DEFAULT 0 CHECK (held_mc >= 0),
  earned_total_mc     INTEGER NOT NULL DEFAULT 0,
  spent_total_mc      INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS nodes (
  node_id        TEXT PRIMARY KEY,                   -- lowercase EVM address of the node key
  account_id     TEXT NOT NULL REFERENCES accounts(id),
  pool_id        TEXT NOT NULL,
  gpu            TEXT NOT NULL,
  mem_gb         REAL NOT NULL,
  registered_at  INTEGER NOT NULL,
  -- latest signed heartbeat (POST /nodes/heartbeat); the pool layer map is built from these (SPEC §5.5)
  hb_ts          INTEGER,                            -- gateway receive time, ms
  hb_online      INTEGER,
  hb_model       TEXT,
  hb_layers      TEXT,                               -- JSON [start, end) or NULL
  hb_tok_s       REAL
);
CREATE TABLE IF NOT EXISTS node_reliability (
  node_id              TEXT PRIMARY KEY REFERENCES nodes(node_id),
  requests_routed      INTEGER NOT NULL DEFAULT 0,
  requests_ok          INTEGER NOT NULL DEFAULT 0,
  heartbeats_expected  INTEGER NOT NULL DEFAULT 0,
  heartbeats_received  INTEGER NOT NULL DEFAULT 0,
  score                REAL NOT NULL,
  updated_at           INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS requests (
  req_id               TEXT PRIMARY KEY,             -- req_…
  account_id           TEXT REFERENCES accounts(id), -- null for x402
  x402_payer           TEXT,                         -- Hedera account ID
  x402_tx              TEXT,                         -- Hedera tx ID
  x402_amount_tinybar  TEXT,
  model                TEXT NOT NULL,
  pay_type             TEXT NOT NULL CHECK (pay_type IN ('credits', 'x402')),
  in_tokens            INTEGER,
  out_tokens           INTEGER,
  cost_mc              INTEGER,
  split                TEXT,                         -- JSON CreditSplit
  route                TEXT,                         -- JSON Route (node → layers); NULL = unknown (SPEC §5.5)
  status               TEXT NOT NULL CHECK (status IN ('pending', 'ok', 'failed')),
  prompt_hash          TEXT NOT NULL,
  resp_hash            TEXT,
  hcs_seq              INTEGER,
  ts                   INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS ledger_events (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  type         TEXT NOT NULL,
  payload      TEXT NOT NULL,                        -- JSON LedgerEvent (with sig)
  gateway_sig  TEXT NOT NULL,
  hcs_seq      INTEGER,                              -- null until written to HCS
  ts           INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS epochs (
  epoch          INTEGER PRIMARY KEY,
  start_ts       INTEGER NOT NULL,
  end_ts         INTEGER NOT NULL,
  total_tinybar  TEXT NOT NULL,
  merkle_root    TEXT,
  post_tx        TEXT,
  status         TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS epoch_payouts (
  epoch           INTEGER NOT NULL REFERENCES epochs(epoch),
  payout_address  TEXT NOT NULL,
  amount_tinybar  TEXT NOT NULL,
  proof           TEXT NOT NULL,                     -- JSON array of Hex32
  claimed         INTEGER NOT NULL DEFAULT 0,
  claim_tx        TEXT,
  PRIMARY KEY (epoch, payout_address)
);
CREATE TABLE IF NOT EXISTS transcripts (
  req_id      TEXT PRIMARY KEY REFERENCES requests(req_id),
  prompt      TEXT NOT NULL,
  response    TEXT,
  expires_at  INTEGER NOT NULL                       -- 7 days (SPEC §14)
);
`;

export type Db = Database.Database;

export function openDb(path: string): Db {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  const version = db.pragma("user_version", { simple: true }) as number;
  const hasTables = (db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type = 'table'").get() as { n: number }).n > 0;
  if (hasTables && version !== SCHEMA_VERSION) {
    db.close();
    throw new Error(`database ${path} has schema v${version}, need v${SCHEMA_VERSION}: delete the file and restart (dev phase, no migrations)`);
  }
  db.exec(SCHEMA);
  db.pragma(`user_version = ${SCHEMA_VERSION}`);
  return db;
}
