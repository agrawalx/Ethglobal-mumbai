# gateway (C3-C6, TypeScript)

OpenAI-compatible API, World login, x402, credit ledger (SQLite), HCS writer, node registry/heartbeats.
Spec: `docs/SPEC.md` §5-10. Node 24 + Hono + `better-sqlite3` (WAL).

```bash
cp .env.example .env
pnpm --filter @gpupool/gateway start
pnpm --filter @gpupool/gateway test        # fake Parallax / World / facilitator, no network
node test/fake-parallax.ts 3200            # fake pool for live checks (never use port 3001 for this)
node --env-file=.env scripts/dev-session.ts <label>   # DEV ONLY: account + session without World (needs the DB file + JWT_SECRET)
node src/verify-event.ts <seq> <gateway_pubkey>       # anyone: check one HCS message (mirror node + ed25519)
```

## Endpoints (step 2)

| Endpoint | Auth | Notes |
|---|---|---|
| `POST /v1/chat/completions` | session **or** x402 | Bearer present → must be valid (else 401). Session: hold → forward → settle from `usage` (`src/billing.ts`, `src/ledger.ts`). No Bearer: x402 (`src/x402.ts`). |
| `POST /auth/world/rp-signature` | none | `RpSignatureResponse` (IDKit v4 RP signature). |
| `POST /auth/world/verify` | none | IDKit result forwarded unchanged → `WorldVerifyResponse` (JWT HS256, 24 h). |
| `GET /me` | session | `MeResponse`. |
| `POST /nodes/register` | session | `NodeRegisterRequest` from the `gpupool-node init` link. Max 3 nodes. Payout address required once → `payout_address_set`. |
| `POST /nodes/heartbeat` | node signature | EIP-191 over the raw body, ts ± 60 s, registered nodes only. → `HeartbeatResponse`. |
| `GET /pools/:pool_id` | none | `PoolStateResponse` (members + layer map from fresh heartbeats). The coordinator writes `gpupool.pool` from it. |
| `GET /requests/:id` | none | `Receipt` (route, cost, split, x402 payer/tx, hcs_seq). |
| `GET /v1/models` | none | Arkiv model catalog filtered to fresh, ready, reachable Arkiv pools. |
| `GET /network` | none | Arkiv pool/node listings; minimum pool reliability and gateway active load. |
| `GET /ledger/events?limit=50` | none | Signed recent ledger events, newest first; HCS sequence or null while queued. Limit 1–100. |
| `GET /payouts/:address` | none | Confirmed epoch proofs, claim delay, claim/sweep status. |

Errors: shared shape. 401 unauthorized, 402 only x402, **403 `insufficient_credits`**, 403 `node_limit_reached`, 409 node of another account, 502 `pool_error`.

## Credits (step 2.2)

- Hold = `model_factor × (max_tokens + 0.2 × ceil(chars/4))`, one conditional `UPDATE` (concurrent requests cannot overspend). Starter credits count only before `starter_expires_at`.
- Settle (one transaction): cost from `usage`, capped at the hold; starter first, then earned; split 90/5/5 by layers; **self-request rule** (`paysNode`): the requester's own node gets 0, the share goes to reserve; route unknown → all node shares to reserve. `request_settled` event, `requests` row, `transcripts` (7 days).
- Failed request: hold released, cost 0, `node_reliability.requests_routed` +1 without `requests_ok` (client abort: no penalty). No event.
- Starter expiry job: every 60 s, `credits_expired` event.
- Route (SPEC §5.5, `src/route.ts`): latest fresh heartbeats of the pool's nodes; valid only if they cover `[0, num_layers)` exactly once.
- Reliability: persisted rolling request and heartbeat observations; see "Reliability and priority" below.

## HCS (step 2.3)

Events are signed (ed25519, `GATEWAY_SIGNING_KEY` seed) and inserted into `ledger_events` in the same transaction as the balance change. `src/hcs.ts` submits unsent rows in id order every second (back-off up to 30 s on failure; restart-safe) and fills `ledger_events.hcs_seq` and `requests.hcs_seq`. Requests never wait for HCS.
Gateway public key: `0x9750f108f4273406aa7498086fc73b404633e5750d9f1d3dacfd95c1cc58c508`. Topic `0.0.11332608`: https://hashscan.io/testnet/topic/0.0.11332608
Live (6 Nov): seq 1 `account_created` for `acc_hcslivecheck23` (synthetic live-check event, no such account: ignore it when rebuilding), seq 2-3 `x402_payment`, seq 4-5 dev account `account_created` + `starter_grant`, seq 6 `payout_address_set` (local test DB, placeholder address), seq 7 `request_settled`; seq 1-7 all `schema: valid, signature: valid` with `verify-event.ts`.

## x402 (step 2.4)

`@x402/core` `x402HTTPResourceServer` directly, not the `@x402/hono` middleware: the middleware settles **after** the handler and buffers the whole response (breaks streaming), and SPEC §7.2 settles before serving. The price is a `DynamicPrice` from the parsed body (shared config tier for model + max_tokens). No `PAYMENT-SIGNATURE` → 402 with `PAYMENT-REQUIRED`. With it → facilitator verify → settle → forward; `PAYMENT-RESPONSE` on the answer. The facilitator `/supported` is fetched on the first paid request.
**Paid but the pool failed:** recorded as `status=failed` with payer/tx/amount, no `x402_payment` event, **no refund** (out of scope).
Live (6 Nov, agent-client, 2 questions, fake pool): `0.0.9185802@1793930570.679764006`, `0.0.9185802@1793930571.004892345` (SUCCESS, 0.02 HBAR each to treasury `0.0.11331600`).

## World ID (step 2.1), IDKit v4 findings (checked 6 Nov 2026)

| Item | Finding |
|---|---|
| RP signature | `signRequest({signingKeyHex, action})` from `@worldcoin/idkit-core/signing` 4.6.0 (from `@worldcoin/idkit-server` 1.2.0). secp256k1, EIP-191 over `0x01 ‖ nonce(32) ‖ created_at(u64 BE) ‖ expires_at(u64 BE) ‖ hash_to_field(action)` (81 bytes); `sig` = r‖s‖v; ttl 300 s. `rp_id` and signal are not signed. Docs: https://docs.world.org/world-id/idkit/signatures |
| Frontend use | `rp_context = { rp_id, nonce, created_at, expires_at, signature: sig }`, plus `app_id`, `action`, `environment` (all in our response). Selfie: the `selfieCheck({signal})` preset. https://docs.world.org/world-id/idkit/integrate |
| Verify | `POST https://developer.world.org/api/v4/verify/{rp_id}`, **no auth**, body = IDKit result unchanged. 200 `{success:true, nullifier:"0x…", environment, results:[{identifier, success, nullifier}], message}`. https://docs.world.org/api-reference/developer-portal/verify |
| Credential | `results[].identifier`: `proof_of_human` (Orb), `selfie` (Selfie Check, `issuer_schema_id` 11). Legacy v3: `orb`, `face`. We accept those; others (`passport`, …) → 401. |
| Duplicate | The portal returns **200** for a reused nullifier (`"Proof verified successfully (nullifier reuse)"`). Our `world_nullifier` UNIQUE (stored as 32-byte lowercase hex) is the only guard. |
| Errors | `{code, detail, attribute}` (e.g. 400 `validation_error`, `rp_not_active`, `app_not_migrated`) or `{success:false, code, detail, results}` (400 `all_verifications_failed`). We return 401 `unauthorized` with `code: detail`. |
| Live check | Invalid proofs to our `rp_831104fa5fd04dd5`: Selfie → 400 `validation_error` "sybil_score is required…"; Orb → 400 `all_verifications_failed`. So the URL and RP are valid; the shapes match. |
| Not verified | A real World App / simulator login (needs the frontend + a phone/simulator). Whether World App blocks a second proof for the same action (repeat login) is unconfirmed; if it does, repeat logins need IDKit session proofs. Pre-create the action `gpupool-account` in the portal (staging) to be safe. |

SQLite: all SPEC §8.7 tables (`src/db.ts`), `SCHEMA_VERSION` 10 (verification, privacy, incentives, and durable epoch settlement). No migrations: delete the DB file when the version changes.

Unverified: that Parallax honours `stream_options.include_usage` (if not, streaming requests end with `ok:false, reason:"no_usage"` and cost nothing); real inference through the gateway (only one node exists now).

## Arkiv routing (step 3.1)

`src/router.ts` reads the Arkiv model catalog and ready pool listings with `@gpupool/arkiv`.
Set `ARKIV_RPC_URL`, `ARKIV_CHAIN_ID`, and optionally `ARKIV_ACCESS_KEY` in `gateway/.env`.
Reads need no wallet or private key. Seed the model catalog with the Arkiv CLI before discovery.

For this one-pool MVP, the private URL is `POOL_COORDINATOR_URL`; its exact UTF-8 keccak256
must match the coordinator listing's `coordinator_url_hash` (`COORDINATOR_URL` in the node agent).
Unknown hashes are excluded. Every listed member must be registered in that pool and have an
online heartbeat received within 30 seconds reporting the requested model (GPU or MLX variant). Pool score is the minimum stored member reliability
multiplied by `1 - load`, where `load = active_requests / (active_requests + 1)`.
Request completion, failure, and stream cancellation release the active count and pool slot.

The selected pool supplies the receipt's layer map from signed heartbeats; an invalid map remains
`null` under SPEC §5.5. No ready pool returns `503 no_pool_available` with `Retry-After`, before
holding credits or charging x402. `/v1/models` returns an empty list when no pools qualify;
Arkiv read failures return 503 for both paths. There is no fallback to Parallax discovery.

## Reliability and priority (step 3.2)

`src/reliability.ts`: score = 0.7 × request success rate + 0.3 × online heartbeat rate,
using persisted observations from the last seven days. Missing rates use 0.8. Every node on a failed
route gets a failed outcome; client cancellation before completion and unknown routes add no outcome.
No credits are deducted for reliability. Online heartbeat samples count once per registration-aligned
slot. Set gateway `HEARTBEAT_SECONDS=10` to match the node agents. Offline reports do not count as
online samples. Scores refresh on events, `/me`, and the heartbeat timer, including when nodes stop.
The existing heartbeat response feeds the score to each node's Arkiv listing (no per-request writes).
Credit completion commits balances, the ledger event, transcript, and reliability outcome in one
transaction. A persistence failure rolls back settlement and releases the hold and pool slot.

`src/queue.ts`: one active inference per pool. Waiting requests use descending contribution ratio,
x402 = 1, equal ratios FIFO. Waiting does not hold credits or charge x402. Disconnected waiters are
removed. Pool readiness and the layer map are checked again at admission. Completion, failure, stream
cancel, and rejected payment preparation release the slot. Queue state is in memory.

SQLite schema is now version 6 (see "Pool checks" below). Existing older development
databases must be recreated before startup; no files are deleted automatically. Reliability observations survive a gateway restart.

## Stall detection and failover (post-MVP P5.1/P5.2)

`src/stall.ts` keeps the gaps between content chunks of each pool in memory and gives two limits:
first token (`first_token_base_ms` + `first_token_ms_per_input_token` × input) and next token
(max of `stall_min_ms` and `stall_p95_factor` × p95 gap). Values: `shared/config` `resilience`.
`src/chat.ts` forwards whole SSE events (never an upstream error event; `[DONE]` once at the end).
On a stall, an error event, or an end without `usage`, it calls the billing failover hook once
(`max_failovers`): before any token the retry starts again; after tokens it continues the partial
answer (`continue_final_message`). The client sees `: failover` and one stream. The user pays the
attempt that completed; failed attempts are reliability failures for their routes; the receipt has
`attempts`. SPEC §5.3 step 12. With one pool the retry goes to the same scheduler.
Not verified live: that the Parallax nodes (vLLM Rust frontend) accept `continue_final_message`
with the Qwen3 chat template. If they do not, set `continuation: false` (failover then happens
only before the first token).

## Pool checks (post-MVP P5.4, P5.5, P5.7, P5.8, P5.9)

`src/pools.ts`, fed by the signed heartbeats (`src/nodes.ts`) and the `pool/hooks` files on this host:
- **Restart orders (P5.5):** a node whose layers change while online → `pools.restart_id + 1`
  (cool-down `restart_cooldown_s`). Heartbeat responses carry `restart_id`; the pool counts as
  restarting (router skips it, `/pools` says `loading`) until every member sends `restart_ack`,
  at most `restart_timeout_s`.
- **Swap (P5.7):** a member with `mem_pressure = swap_growing` takes its pool out of routing.
- **Allow-list (P5.4):** with `PARALLAX_ALLOWED_PEERS_FILE`, every heartbeat rewrites (only on change)
  the peer IDs of registered nodes with a fresh heartbeat; the scheduler hook admits only these.
- **Exact route (P5.8):** with `PARALLAX_ROUTE_LOG`, requests carry `gpupool_req_id`; at completion
  the logged `routing_table` is mapped to nodes by `peer_id`; receipts show `route_source`.
- **Cross-check (P5.9):** `/network` `route_dispute` compares `served_sessions` reports with the route
  log per member (`route_check_*` in `shared/config`). Flag only.

SQLite schema is now version 6 (`pools`, `node_served`, P5 heartbeat columns, `requests.route_source`).
Tests: `test/failover.test.ts`, `test/p5.test.ts`.

## Epoch settlement and provider payouts (step 3.3)

`src/settlement.ts` runs every 10 seconds when `PAYOUT_CONTRACT_ADDRESS` is set. It closes completed
`EPOCH_SECONDS` periods (default 600), defers periods with in-flight x402 requests, and calculates
80% provider shares per successful request using BigInt tinybars and per-node layer floors. Rounding,
self shares, missing payout addresses, unknown routes, and paid-but-failed requests stay in treasury.
One settled payment ID can fund providers only once. Provider owners, wallets, and layer ranges are
snapshotted into `requests.payout_snapshot` when the paid request starts; later wallet changes cannot
redirect that income. The payer's Hedera account is resolved through the testnet mirror node;
a payer matching the provider's registered payout wallet is treated as a self-request.

Each epoch stores its payout list, sorted-pair Merkle root/proofs, and signed `epoch_closed` event
atomically. If the full event would reach 1024 bytes, only the canonical payout-list hash is included;
the list remains in `epoch_payouts`. HCS must confirm this commitment before funding or posting.
Empty provider epochs are audited but never posted. The TS tree matches the Solidity test vector.

Configure these existing keys in `gateway/.env`:

- `HEDERA_NETWORK=testnet`, `HEDERA_CHAIN_ID=296`, `HEDERA_JSON_RPC_URL`, `HEDERA_MIRROR_URL`.
- `TREASURY_ACCOUNT_ID`, `TREASURY_PRIVATE_KEY` (ECDSA), `X402_PAY_TO` equal to the treasury ID.
- `SETTLER_PRIVATE_KEY` (ECDSA) matching the deployed contract's `settler()`.
- `PAYOUT_CONTRACT_ADDRESS`, `EPOCH_SECONDS=600`, and the HCS writer keys/topic.

The worker verifies RPC chain, settler, and treasury identity before any transaction. Treasury funds
exactly the provider total to the settler, then the settler calls payable `postEpoch`. If they are the
same wallet, the transfer is skipped. The settler must be pre-funded for transaction gas; the treasury
also needs gas. Reserve these wallets for the single worker so external transactions cannot consume
its prepared nonces. Signed raw transactions and hashes are saved **before** broadcast. Restart/retry
reuses the same bytes; a reverted transaction or conflicting root stops that epoch for review.
Tinybars become JSON-RPC weibars with `× 10^10`; claim arguments stay tinybars. See
[viem's signing flow](https://viem.sh/docs/actions/wallet/signTransaction) and `contracts/README.md`.

`GET /payouts/:address` returns only contract-confirmed epochs: proof, root, amount, posting tx,
`claimable_at`, `claimable`, `claimed`, `claim_tx`, and `swept`. Claims and sweeps are read from contract
logs in bounded block ranges. Confirmed claims update SQLite and produce one `payout_claimed` HCS event.
These statuses are refreshed by the worker, so a just-mined claim can take a polling interval to appear.

Provider claims without the frontend:

```bash
cd gateway
cp provider.env.example .env.provider
# Fill GATEWAY_URL, PROVIDER_PRIVATE_KEY, PAYOUT_CONTRACT_ADDRESS, HEDERA_JSON_RPC_URL.
node --env-file=.env.provider scripts/claim-payout.ts                 # preview + on-chain simulation
node --env-file=.env.provider scripts/claim-payout.ts --epoch 123     # preview one epoch
node --env-file=.env.provider scripts/claim-payout.ts --broadcast     # submit; spends testnet gas
```

The claim CLI checks the Merkle proof locally, simulates the call, and submits from the provider's
wallet only with `--broadcast`. Provider keys remain in ignored files. No mainnet is allowed.

## Missing APIs and account-stat publishing

`GET /network` reads all pool statuses and nodes from Arkiv. Listings disappear when Arkiv expires
them. Routing separately enforces fresh signed heartbeats. Pool reliability prefers stored gateway
scores for known members, then published node scores, then the initial score; pool load is the same
active-request measure used by routing. Raw coordinator URLs are never returned. Arkiv outages
return 503 with `Retry-After`.

`GET /ledger/events?limit=50` reads the SQLite audit copy and returns signed payloads plus their
HCS sequence numbers. Pending events have `hcs_seq: null`; the async HCS writer backfills it.
Results are newest event ID first. Invalid/non-integer/duplicate limits or values outside 1–100
return 400. Both APIs are public and use the shared response schemas.

With `ARKIV_PRIVATE_KEY` configured, `src/account-stats.ts` publishes one background batch at
startup and every ten minutes (`shared/config` `arkiv_account_stats_update_s=600`). It uses the
existing owner-scoped Arkiv upsert helper and one-day TTL. Batches do not overlap; individual
failures are logged and retried at the next scheduled batch. HTTP handlers never trigger or await
these writes. No writer key leaves account-stat publishing disabled; read-only discovery still works.
Published fields are pseudonymous account ID, cumulative earned/spent millicredits, contribution
ratio, and minimum node reliability (null for accounts without nodes). Starter grants and remaining
balances are not lifetime contribution totals. World nullifiers, JWTs and private keys are excluded.

## Local verification and later live validation

```bash
pnpm --filter @gpupool/gateway test:demo    # complete backend demo twice with local fixtures
pnpm --filter @gpupool/gateway test         # API, money, queue, signing, stats, settlement tests
pnpm --filter @gpupool/shared test
pnpm --filter @gpupool/arkiv test
```

The two demo runs exercise mock World login/duplicate protection, three real EIP-191 node signatures,
registration/heartbeats, Arkiv model/network discovery and simulated expiry, session inference and
SSE usage, x402 through a local facilitator, signed HCS events, account-stat publishing, epoch close,
provider proof/claim indexing, and the no-pool 503. External services and inference are test fixtures;
these runs do not prove real three-machine inference or public-chain settlement.

Live validation is deferred by the user's MVP instruction. A checker is ready for the configured
live environment:

```bash
pnpm --filter @gpupool/gateway verify                          # read-only readiness; no inference/payment
# Set VERIFY_SESSION_TOKEN in ignored gateway/.env, then:
pnpm --filter @gpupool/gateway verify --inference              # two max_tokens=32 session requests
pnpm --filter @gpupool/gateway verify --provider 0x...          # read-only on-chain claim check
```

The checker requires a ready three-member route for inference and checks usage, receipts, credit
settlement and HCS confirmation. It verifies an existing provider claim against the contract and
transaction log when given testnet RPC/contract config. It never sends an x402 payment or provider
claim. The JSON report defaults to `/tmp/gpupool-live-check.json`; use `--report` to choose another
path. Skipped live inference and claims are explicitly reported as unverified.

## SPEC §16.1 pools (SPEC §3.5)

`src/formation.ts`: per-pool coordinator URLs (`POOL_COORDINATORS`, `POOL_COORDINATORS_FILE`),
listing-writer election (`pools.writer_node`), automatic formation from `auto` nodes (`node_rtt`,
`GET /pools/plan`, loopback only), private DHT prefixes. `src/queue.ts`: `router.max_concurrent_per_pool`
slots. `src/router.ts`: `x-gpupool-privacy: trusted-ends` (+ `TRUSTED_ACCOUNTS`). Current schema version 10.
Tests: `test/s16.test.ts`.

## Privacy (SPEC §5.6, no Parallax change)

`src/privacy.ts`: `x-gpupool-privacy: trusted-ends | trusted-all` routing (router), no transcript for
privacy requests, AES-256-GCM transcripts (`TRANSCRIPT_KEY`; read only via `readTranscript`), salted
`prompt_hash`/`resp_hash` (salt in `requests.hash_salt`, sent to the requester as `x-gpupool-hash-salt`),
HTTPS (`TLS_CERT_FILE`, `TLS_KEY_FILE`). Current schema version 10 (`requests.hash_salt`, `requests.privacy`).
Demo with real values: `pnpm demo:privacy`. Tests: `test/privacy.test.ts`.

## SPEC §16.2 output verification

`src/verification.ts` queues a configurable sample of successful requests and sends the stored
prompt, answer, model, seed, sampling settings, and route to `VERIFIER_URL` at `POST /v1/verify`.
The trusted reference service returns `{score, threshold, reference_hash}`. The gateway derives
`pass` or `flag` from that threshold, records the result in SQLite, updates route-node risk estimates,
and signs a `verification_result` HCS event. Checks run after the request has completed and never
hold the request open. Sampled requests get a random seed if the client did not send one; the same
seed is forwarded to Parallax and kept for replay.

The gateway also sends a fixed, temperature-zero `READY` prompt directly to each idle configured
pool once per hour. It does not bill the requester for this internal canary. It uses the same
reference endpoint with `method: "token-difr-canary"` and records a signed `verification_canary`
event. A canary is skipped if its pool is busy or has no valid route.

Only an account that owns a node on the flagged route can read the result or appeal it:
`GET /verifications/:id` and `POST /verifications/:id/appeal` (JSON `{ "reason": "..." }`).
An appeal is checked by `VERIFIER_SECONDARY_URL`, whose configured owner must be outside that
route. The second result becomes final and is written to HCS. A flag does not change credits,
provider HBAR, or reliability.

Node agents receive a random hardware challenge in a signed heartbeat response, only while the
pool is idle and no more than once per hour. The agent runs a small deterministic integer matrix
multiply using the Parallax CUDA or MLX runtime and returns the checksum in its next signed
heartbeat. The gateway recomputes the expected checksum, checks the reported backend and memory,
and excludes a failed or expired node from routing. This is a practical capability check, not a
hardware attestation; a modified agent can fake its report.

Route risk uses overlapping pass/flag observations to update a noisy-OR Bayesian estimate per node.
This is a first group-testing pass; it does not steer canaries into new routes because the current
deployment has no spare pipelines. It never applies a penalty automatically.

The external reference service must use the published DiFR method with a trusted model matching
the advertised weights and calibration set. Configure `VERIFIER_OWNER_ACCOUNT` and the separate
appeal verifier owner. Without those services and calibration, these checks are disabled or cannot
be trusted. The local tests exercise the gateway protocol and do not calibrate a live model.
Schema version is 10; use a fresh development database after this change.

## Incentives (SPEC §8.8, §16.3)

`src/incentives.ts`: vesting lots, expiry, fraud penalties and bans (from 16.2 final verdicts), node cap,
Passport tier, collusion flags, availability rewards, agent keys. Once-a-minute worker in `main.ts`.
Endpoints: `/agents`, `/incentives/flags` (loopback). Headers: `x-gpupool-pool`, `x-gpupool-min-reliability`.
Schema version 10. Demo: `pnpm demo:incentives`. Tests: `test/incentives.test.ts`.
