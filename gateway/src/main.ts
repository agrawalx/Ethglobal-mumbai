import { serve } from "@hono/node-server";
import { loadConfig, type Config } from "./config.ts";
import { openDb } from "./db.ts";
import { createApp } from "./app.ts";
import { signerFromSeed } from "./events.ts";
import { hederaSubmitter, startHcsWriter } from "./hcs.ts";
import { expireStarterCredits } from "./ledger.ts";
import { createX402 } from "./x402.ts";

let cfg: Config;
let signer;
try {
  cfg = loadConfig();
  if (!cfg.env.GATEWAY_SIGNING_KEY) throw new Error("GATEWAY_SIGNING_KEY is required (signs ledger events)");
  signer = signerFromSeed(cfg.env.GATEWAY_SIGNING_KEY);
} catch (e) {
  console.error((e as Error).message);
  process.exit(1);
}
const e = cfg.env;
const db = openDb(e.DATABASE_PATH);

const x402 = e.X402_FACILITATOR_URL && e.X402_PAY_TO
  ? createX402({ cfg: cfg.net, facilitatorUrl: e.X402_FACILITATOR_URL, network: e.X402_NETWORK ?? "hedera:testnet", payTo: e.X402_PAY_TO })
  : null;
if (!x402) console.warn("x402 not configured (X402_FACILITATOR_URL / X402_PAY_TO): requests without a session get 402");

// HCS writer: async, never blocks a request (CLAUDE.md §4.9). Without operator keys events stay unsent in SQLite.
let stopHcs = () => {};
let closeHcs = () => {};
if (e.HEDERA_OPERATOR_ID && e.HEDERA_OPERATOR_KEY && e.HCS_TOPIC_ID) {
  const h = hederaSubmitter({ network: e.HEDERA_NETWORK ?? "testnet", operatorId: e.HEDERA_OPERATOR_ID, operatorKey: e.HEDERA_OPERATOR_KEY, topicId: e.HCS_TOPIC_ID });
  stopHcs = startHcsWriter(db, h.submit);
  closeHcs = h.close;
} else {
  console.warn("HCS not configured (HEDERA_OPERATOR_ID / HEDERA_OPERATOR_KEY / HCS_TOPIC_ID): ledger events stay in SQLite only");
}

// Starter credit expiry (SPEC §8.2), once a minute.
const expiry = setInterval(() => {
  try {
    const n = expireStarterCredits(db, signer);
    if (n > 0) console.log(JSON.stringify({ msg: "starter_expired", accounts: n }));
  } catch (err) {
    console.error(`starter expiry failed: ${(err as Error).message}`);
  }
}, 60_000);

const app = createApp({ cfg, db, signer, x402 });
const server = serve({ fetch: app.fetch, port: e.PORT, hostname: e.HOST }, (info) => {
  console.log(`gateway listening on http://${info.address}:${info.port} → pool ${e.POOL_COORDINATOR_URL}; gateway pubkey ${signer.publicKeyHex}`);
});

const shutdown = () => {
  clearInterval(expiry);
  stopHcs();
  closeHcs();
  server.close();
  db.close();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
