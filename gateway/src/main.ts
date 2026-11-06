import { serve } from "@hono/node-server";
import { createServer as createHttpsServer } from "node:https";
import { tlsOptions } from "./privacy.ts";
import { loadConfig, type Config } from "./config.ts";
import { openDb } from "./db.ts";
import { createApp } from "./app.ts";
import { createPoolQueue } from "./queue.ts";
import { arkivDirectory, createRouter } from "./router.ts";
import { logCompletion } from "./chat.ts";
import { signerFromSeed } from "./events.ts";
import { hederaSubmitter, startHcsWriter } from "./hcs.ts";
import { expireStarterCredits } from "./ledger.ts";
import { refreshReliability } from "./reliability.ts";
import { expireEarned, payAvailability, runPenalties, unlockDue } from "./incentives.ts";
import { createSettlement, startSettlementWorker } from "./settlement.ts";
import { hederaSettlementChain } from "./payout-chain.ts";
import { arkivStatsWriter, startAccountStatsPublisher } from "./account-stats.ts";
import { createX402 } from "./x402.ts";
import { maybeQueueVerification, startCanaryWorker, startVerificationWorker } from "./verification.ts";

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

// SPEC §16.3 incentives: unlock vested credits, expire old earnings, act on final fraud verdicts,
// pay standby rewards for the last epoch. Local SQLite + HCS events (async writer); once a minute.
const incentiveTick = () => {
  try {
    unlockDue(db);
    expireEarned(db, cfg.net, signer);
    runPenalties(db, cfg.net, signer);
    const paid = payAvailability(db, cfg, signer);
    if (paid > 0) console.log(JSON.stringify({ msg: "availability_paid", mc: paid }));
  } catch (err) {
    console.error(`incentives tick failed: ${(err as Error).message}`);
  }
};
incentiveTick();
const incentivesTimer = setInterval(incentiveTick, 60_000);

refreshReliability(db, cfg);
const reliabilityTimer = setInterval(() => {
  try { refreshReliability(db, cfg); }
  catch (err) { console.error(`reliability refresh failed: ${(err as Error).message}`); }
}, cfg.env.HEARTBEAT_SECONDS * 1000);

let stopSettlement = () => {};
if (e.PAYOUT_CONTRACT_ADDRESS) {
  const chain = hederaSettlementChain(cfg);
  if (!e.HCS_TOPIC_ID || !e.HEDERA_OPERATOR_ID || !e.HEDERA_OPERATOR_KEY) throw new Error("epoch settlement requires the HCS writer configuration");
  stopSettlement = startSettlementWorker(createSettlement(db, cfg, signer, chain));
} else {
  console.warn("epoch settlement disabled: set PAYOUT_CONTRACT_ADDRESS and treasury/settler keys to enable");
}

const statsPublisher = e.ARKIV_PRIVATE_KEY
  ? startAccountStatsPublisher(db, cfg, arkivStatsWriter(cfg))
  : null;
if (!statsPublisher) console.warn("Arkiv account stats disabled: ARKIV_PRIVATE_KEY is not configured");

const router = createRouter(cfg, db, arkivDirectory(cfg));
const queue = createPoolQueue(cfg.net.router.max_concurrent_per_pool);
let stopVerification = () => {};
let stopCanaries = () => {};
if (e.VERIFIER_URL && e.VERIFIER_OWNER_ACCOUNT) {
  stopVerification = startVerificationWorker(db, cfg, signer);
  stopCanaries = startCanaryWorker(db, cfg, signer, router, queue);
} else {
  console.warn("output verification disabled: configure a trusted VERIFIER_URL and VERIFIER_OWNER_ACCOUNT");
}

const app = createApp({ cfg, db, signer, x402, router, queue, onComplete: (completion) => {
  logCompletion(completion);
  if (completion.ok) {
    const id = maybeQueueVerification(db, cfg, completion.reqId);
    if (id) console.log(JSON.stringify({ msg: "verification_queued", verification_id: id, req_id: completion.reqId }));
  }
} });
// Privacy: HTTPS when TLS_CERT_FILE + TLS_KEY_FILE are set (src/privacy.ts); else HTTP (MVP).
let tls: ReturnType<typeof tlsOptions> = null;
try { tls = tlsOptions(cfg); } catch (err) { console.error((err as Error).message); process.exit(1); }
const server = serve({ fetch: app.fetch, port: e.PORT, hostname: e.HOST, ...(tls ? { createServer: createHttpsServer, serverOptions: tls } : {}) }, (info) => {
  console.log(`gateway listening on ${tls ? "https" : "http"}://${info.address}:${info.port} → pool ${e.POOL_COORDINATOR_URL}; gateway pubkey ${signer.publicKeyHex}`);
});

const shutdown = () => {
  clearInterval(expiry);
  clearInterval(reliabilityTimer);
  clearInterval(incentivesTimer);
  void statsPublisher?.stop();
  stopSettlement();
  stopVerification();
  stopCanaries();
  stopHcs();
  closeHcs();
  server.close();
  db.close();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
