# Section 16: before and after

This file covers two separate changes: the 16.2 verification work (first part, below) and the
16.1 inference and pools work (section "16.1 solving report" at the end). The sentences "The
specification file has not been changed" and "This does not change Section 16.1" describe the 16.2
change only. The 16.1 change did update `docs/SPEC.md` (sections 3.4, 3.5, 4.3, 5.3, 5.4, 5.5, 8.7, 16.1).

## Before

Section 16 was a list of work to do after the MVP.

- **16.1 Pools:** handling broken nodes, pool changes, new pools, and privacy work.
- **16.2 Verification:** check model answers, choose a checker, allow appeals, test the hardware, and find which nodes caused a bad result.
- **16.3 Credits and reputation:** lock credits, punish fraud, and detect unfair activity.
- **16.4 Payments and directory:** add more payment types and contract features.

The specification said these items were outside the MVP.

## After

The specification file has not been changed. Section 16 still describes work outside the MVP.
This code change adds the verification work from Section 16.2:

- The gateway sometimes sends a finished answer to a trusted Token-DiFR checker.
- It sends a fixed test prompt to an idle pool once an hour.
- A node owner can see a failed check and ask for a second check in time.
- A node gets a small hardware test in a signed heartbeat. A failed test stops that node from serving.
- The gateway uses results from different routes to estimate which nodes may be at fault.

The specification file has not been changed. Section 16.1, 16.3, and 16.4 are unchanged. A failed check does not take credits or HBAR and does not lower reliability. The checks need trusted reference services and calibration data. They have not been run against the live pool.

---

# 16.1 solving report (inference and pools)

Branch `backendXoutofscope`, 6 Nov 2026. Plan: `docs/POST_MVP_PLAN.md` (P5, P9). Simple-words
version: `docs/SECTION16_REPORT.md`.

## Rules kept from the MVP

- Parallax stays an installed dependency (commit `162354a`). We never edit its files. Changes inside
  Parallax are **runtime hooks** in `pool/hooks/` that patch a few helper methods after import.
  A test reads the Parallax source and fails if a patched method changes.
- The Parallax API stays on `127.0.0.1`; only the gateway calls it. Every pool scheduler runs on
  the gateway host.
- The gateway decides from **signed node heartbeats**; Arkiv stays the public directory; the
  router rule `reliability × (1 − load)` is unchanged.
- Billing rules do not change: SPEC §8.1 cost, 90/5/5 split, self-request rule, x402 never refunded.
- Requests never wait for HCS or Arkiv writes. No per-request Arkiv writes.
- New behaviour is off or MVP-equal by default, except the runtime hooks (`HOOKS=1`) and the Mac
  memory-flag check.

## Result

| # | Item | Status |
|---|---|---|
| 1 | Fault tolerance | Done (gateway failover). Stage replay inside Parallax: out (needs a Parallax change). |
| 2 | Stall detection | Done. Exact stalled stage: partial (late-heartbeat suspects only). |
| 3 | Node join and leave while the pool runs | Done |
| 4 | Heartbeat grace hook | Done |
| 5 | Ghost guard and admission hook | Done |
| 6 | Clean restart after reassignment | Done |
| 7 | Network address change | Done (firewall stays manual) |
| 8 | Automatic pool formation | Done |
| 9 | Many pools and coordinator election | Done |
| 10 | Exact route for each request | Done |
| 11 | Coordinator cross-check | Done (flag only) |
| 12 | WAN / Global Host | Partly done (script support; no relay run, no internet test) |
| 13 | Memory-aware scheduling | Done |
| 14 | Speculative decoding, batching tuning | Batching done. Speculative decoding: not possible without changing Parallax. |
| 15 | Privacy | Done without changing Parallax: trusted-ends / trusted-all routing, encrypted transcripts, salted public hashes, HTTPS, no prompt logs. |

## Item by item

### 1–2. Fault tolerance and stall detection (P5.1, P5.2)

**Problem.** Parallax notices a dead node only through a 30 s heartbeat timeout; a broken stream hung
up to 180 s. Parallax retries only before forwarding starts, so a node leaving mid-answer always
failed the request.

**Solution.**
- `gateway/src/stall.ts` keeps the gaps between tokens of each pool in memory. Limits: first token
  (or headers) within `first_token_base_ms + first_token_ms_per_input_token × input`; next token
  within `max(stall_min_ms, stall_p95_factor × p95 gap)`. Defaults 30 s + 20 ms/token, 5 s, ×10.
- `gateway/src/chat.ts` forwards whole SSE events (never an upstream error event; one `[DONE]`). A
  stall, an error event, or an end without `usage` starts one failover (`max_failovers`).
  - Before any token: the retry starts from the beginning.
  - After tokens: the retry continues the answer. The partial answer becomes the final assistant
    message (`continue_final_message: true`, `add_generation_prompt: false`), `max_tokens` = what is left.
  - The client sees one stream and a comment line `: failover`.
- `gateway/src/billing.ts` failover hook:
  - the failed attempt is a reliability failure for its route;
  - the router picks another ready pool, else the same pool if still ready, and the pool slot moves;
  - the request route and the x402 payout snapshot follow the answering attempt;
  - the receipt lists `attempts` (pool, route, outcome, streamed tokens, late-heartbeat nodes).
- Billing: the user pays the SPEC §8.1 cost of the attempt that completed, never more than the hold.
  Tokens of a failed attempt are free.

**Limits.** With one pool the retry goes to the same scheduler; it helps only if Parallax routes
around the failed node. `continue_final_message` through the vLLM Rust frontend is not verified
live (`resilience.continuation: false` turns mid-answer failover off).

**Tests.** `gateway/test/failover.test.ts` (8), plus `nodes.test.ts`, `x402.test.ts` cases.

### 3. Node join and leave while the pool runs

**Problem.** When a node left and no full pipeline remained, Parallax reloaded every node at once.

**Solution.**
- Hook `patch_scheduler` (`pool/hooks/gpupool_hooks.py`) waits `REBALANCE_COOLDOWN_S` (default 60)
  before that global rebalance. If the node returns or a full pipeline exists again, the reload is
  cancelled. After the cool-down, the same Parallax rebalance runs in the scheduler's event-loop thread.
- **Spare copies:** with more nodes than one pipeline needs, Parallax forms extra pipelines. A leave
  that keeps one full pipeline triggers no rebalance.
- Live re-placements lead to a clean restart (item 6).

**Tests.** `pool/hooks/test_hooks.py`: delayed rebalance, cancel on recovery, spare pipeline.

### 4. Heartbeat grace hook (P5.3)

**Problem.** A node's heartbeat clock started at join time, and it sends heartbeats only after it
gets layers. A node that waited more than 30 s for placement was removed at once.

**Solution.** Hook on `NodeManager.activate` / `register_pipelines` / `extend_registered_pipelines`:
a node that moves standby → active gets `last_heartbeat = now`. Already active nodes are not revived.

**Tests.** `test_hooks.py` (grace), plus the Parallax source pin check.

### 5. Ghost guard and admission (P5.4)

**Problem.** Leftover processes rejoined through `node_update` (Parallax auto-joins unknown nodes)
and became ghost nodes. Any peer that knew the DHT prefix could join.

**Solution.**
- Hook on `RPCConnectionHandler.build_node`:
  - rejects `node_update` from a peer the scheduler does not know;
  - rejects `node_join` without hardware details.
  Parallax turns the rejection into a failed join.
- Optional admission (`ALLOWED_PEERS_FILE`): a join waits ≤ 30 s for its peer ID in an allow-list.
  - Parallax nodes get a new peer ID at every start, so a node-side hook writes it to
    `pool/run/node.peer-id` before the join.
  - The node agent sends it in its signed heartbeat (`peer_id`).
  - The gateway writes the list from fresh heartbeats (`PARALLAX_ALLOWED_PEERS_FILE`).

**Limit.** With admission on, nodes cannot join while the gateway is down.

**Tests.** `test_hooks.py` (guard, admission, peer-ID file); `gateway/test/p5.test.ts` (allow-list file).

### 6. Clean restart after reassignment (P5.5)

**Problem.** After a live re-placement, requests hung on a stale peer until a manual restart.

**Solution.**
- The gateway treats a node whose layers change while it stays online as a live re-placement. It
  orders a pool restart (`pools.restart_id`, cool-down `restart_cooldown_s` = 120 s).
- Heartbeat responses carry `restart_id`. The router skips the pool, and `/pools` shows `loading`,
  until every member sends `restart_ack` (at most `restart_timeout_s`).
- The node agent (`AUTO_RESTART=true`) runs `pool/restart.sh`: stop the process group, the coordinator
  restarts the scheduler, members rejoin after `RESTART_JOIN_DELAY_S`.
- `lib.sh` writes a start marker in each log, so the agent never reports a stopped process's layers.
  A restart passes through "offline", so it does not trigger another one.

**Tests.** `p5.test.ts` (order, all members, router skip, cool-down, ack, timeout); node agent `test_p5.py`.

### 7. Network address change (P5.6)

**Problem.** Parallax announces the IP from `pool/node.env`; when DHCP changed it, the node silently
stopped working.

**Solution.**
- The node agent sends its current address (`lan_ip`).
- If it differs from `LAN_IP`, `AUTO_RESTART=true` runs `pool/restart.sh --lan-ip <new>` (rewrites
  the env files, restarts); otherwise it prints the command.
- Firewall changes still need a person (sudo rule).

**Tests.** Node agent `test_p5.py`.

### 8. Automatic pool formation

**Problem.** A person had to choose pool members.

**Solution.**
- A node registers with `pool_id: "auto"`. Its heartbeats send `usable_mem_gb`, `lan_ip` and
  `p2p_port`.
- The gateway hands out `probe` lists (at most every `probe_every_s`). The agent measures TCP-connect
  delay (best of 3; a refused connect still measures) and reports `rtt_ms`.
- `gateway/src/formation.ts` grouping:
  - every pair in a group must be ≤ `max_rtt_ms` (5 ms);
  - the group grows until it can hold the largest catalog model (size × 1.2), else the largest model
    it can hold;
  - a pool needs at least `min_nodes`;
  - pool ID `auto-<hash>`, private DHT prefix = HMAC of a gateway secret;
  - formed pools are not re-planned.
- Heartbeat responses carry `assigned_pool`. The agent restarts with `--dht-prefix` and remembers the pool.
- `pool/pools-up.sh` on the gateway host:
  - reads `GET /pools/plan` (loopback only, because it contains the private DHT names);
  - starts one scheduler per pool;
  - writes `pool/run/coordinators.json` for the gateway.

**Tests.** `gateway/test/s16.test.ts` (probes, grouping, model choice, plan, loopback guard,
re-registration keeps the pool); node agent `test_p5.py` (delay measurement); `pools-up.sh` dry run
against a fake plan server.

### 9. Many pools and coordinator election

**Problem.** One fixed coordinator URL; one fixed node wrote the pool listing.

**Solution.**
- **Per-pool coordinators:** each pool's scheduler runs on the gateway host on its own `127.0.0.1`
  port (`API_PORT`, `PROCESS_NAME`). The gateway maps pool → URL from `POOL_COORDINATORS` (JSON) and
  `POOL_COORDINATORS_FILE`. A listing is reachable only if its `coordinator_url_hash` matches that URL.
- **Election:** the current writer stays while its heartbeat is fresh; otherwise the most reliable
  fresh online member is elected (`pools.writer_node`).
  - Heartbeat responses carry `pool_writer` and the pool's `coordinator_url_hash`.
  - Only the writer upserts `gpupool.pool`.
  - A stopped writer is replaced at the next heartbeat; its listing expires (120 s TTL).

**Tests.** `s16.test.ts` (routing to the right scheduler, hash mismatch → 503, election, replacement).

### 10. Exact route (P5.8)

**Problem.** The route came from heartbeat layer maps, not from what Parallax really used.

**Solution.**
- With `PARALLAX_ROUTE_LOG`, the gateway sends `gpupool_req_id`.
- Hook on `RequestHandler._prepare_backend_request`: logs the `routing_table` (peer IDs) to
  `pool/run/routes.jsonl` and removes the field, so the node backend never sees it.
- At completion the gateway maps the peer IDs to nodes (heartbeat `peer_id` + layers).
  - A valid map becomes the route (`route_source = scheduler`).
  - Otherwise the heartbeat map stays (`route_source = heartbeat`).
- The x402 payout snapshot follows the route.

**Tests.** `p5.test.ts`, `test_hooks.py`.

### 11. Coordinator cross-check (P5.9)

**Problem.** The coordinator's report was trusted.

**Solution.**
- Nodes run with `--notify-url` to the node agent (`NOTIFY_PORT`). The agent counts new distinct
  sessions and sends `served_sessions` in signed heartbeats.
- Per member, over `route_check_window_s` (1 h), the gateway compares reported sessions with the
  forwards in the route log. If routed ≥ 5 and the difference is > 20 %, it sets `route_dispute = true`
  on `/network` and logs a warning.
- **Flag only:** no credit change (that needs 16.3 vesting).

**Tests.** `p5.test.ts`; node agent `test_p5.py`.

### 12. WAN / Global Host (partly done)

**Solution.** Pool scripts pass our own `SCHEDULER_ADDR` (`-s`), `RELAY_SERVERS` and `INITIAL_PEERS`
to Parallax. Public relays are never used by default.

**Not done.** Running a relay server; testing a pool over the internet; latency rules for
internet-wide pools.

### 13. Memory-aware scheduling (P5.7)

**Problem.** A 16 GB Mac could plan for all its memory and swap.

**Solution.**
- `join-node.sh` refuses a Mac without `--kv-cache-memory-fraction` and `--max-sequence-length`.
- The agent reports `usable_mem_gb` (Mac: memory − max(4 GB, 25 %)).
- `mem_pressure = swap_growing` is reported when swap grows > 256 MB in 5 min while serving.
- The router skips a pool with a swapping member.

**Tests.** `p5.test.ts`, node agent `test_p5.py`.

### 14. Speculative decoding and batching tuning

**Batching (done).** `router.max_concurrent_per_pool` sets the requests per pool at once (default 1
= MVP). Parallax batches them; node `MAX_BATCH_SIZE` sets `--max-batch-size`. Tests: `s16.test.ts`.

**Speculative decoding (not done).** Parallax `162354a` has no user-facing switch for it (only
internal SGLang types). Adding it would mean changing Parallax, which `CLAUDE.md` §3 forbids. Research
(FlowSpec) expects at most about 1.4–1.7× for pipelines.

### 15. Privacy (done, no Parallax change)

**Problem.**
- Any node could hold the layers closest to the prompt.
- Transcripts (prompt + answer) were stored as plain text for 7 days.
- `prompt_hash` on the public HCS ledger let anybody test guesses of short prompts.
- The gateway had no HTTPS.
- Parallax at debug level logs whole prompts.

**Solution** (`gateway/src/privacy.ts`, SPEC §5.6):
- **Routing:** `x-gpupool-privacy: trusted-ends` puts the first and last layers on nodes of the
  requester or `TRUSTED_ACCOUNTS`. `trusted-all` puts **every** layer there, so no untrusted machine
  sees any data. No such pool → 503.
- **Storage:**
  - privacy requests store no transcript, only hashes;
  - other transcripts are AES-256-GCM encrypted (`TRANSCRIPT_KEY`);
  - verification reads them only through `readTranscript`.
- **Ledger:** salted hashes `sha256(salt:data)` with a per-request salt. The requester receives the
  salt (`x-gpupool-hash-salt`) to check the receipt; the salt is never public.
- **Transport:** HTTPS with `TLS_CERT_FILE` + `TLS_KEY_FILE`. Operators can pin layers with
  `START_LAYER`/`END_LAYER`.
- **Logs:** the pool scripts refuse debug logging unless `ALLOW_DEBUG_LOGS=1`.

**Not done.** Hiding hidden states from untrusted middle nodes (would need a Parallax change). Use
`trusted-all` instead.

**Tests and demo.**
- `gateway/test/privacy.test.ts` (5): encryption round trip and tamper check, salted hashes vs a
  dictionary guess, requester check, salt not on the receipt, both routing modes, no transcript for
  privacy requests, real HTTPS (TLS 1.3) with an openssl certificate.
- Demo with real data: `pnpm --filter @gpupool/gateway demo:privacy`.

## Changes to shared interfaces and data

- `shared/src/api.ts`:
  - `NodeHeartbeat` + `peer_id`, `lan_ip`, `mem_pressure`, `usable_mem_gb`, `served_sessions`,
    `restart_ack`, `p2p_port`, `rtt_ms`;
  - `HeartbeatResponse` + `restart_id`, `pool_writer`, `coordinator_url_hash`, `assigned_pool`, `probe`;
  - `PoolStateResponse` + `restarting`;
  - `NetworkResponse` pools + `route_dispute`, `restarting`;
  - `Receipt` + `attempts`, `route_source`;
  - new `PoolPlanResponse`, `RequestAttempt`.
- `shared/config/gpupool.config.json`: `resilience`, `router.max_concurrent_per_pool`, `pool_formation`.
- Gateway SQLite schema **9** (8 = the 16.2 verification tables, 9 = privacy columns `requests.hash_salt`, `requests.privacy`):
  - new `pools`, `node_served`, `node_rtt` tables;
  - new heartbeat columns on `nodes`;
  - `requests.attempts`, `requests.route_source`;
  - delete the development database before starting.
- New env keys (all in `.env.example` files and `docs/HANDOFF.md` §8):
  - gateway `PARALLAX_ALLOWED_PEERS_FILE`, `PARALLAX_ROUTE_LOG`, `POOL_COORDINATORS`,
    `POOL_COORDINATORS_FILE`, `TRUSTED_ACCOUNTS`;
  - pool `HOOKS`, `NOTIFY_PORT`, `ALLOWED_PEERS_FILE`, `ALLOW_MAC_DEFAULT_MEMORY`, `API_PORT`,
    `PROCESS_NAME`, `REBALANCE_COOLDOWN_S`, `SCHEDULER_ADDR`, `RELAY_SERVERS`, `INITIAL_PEERS`,
    `START_LAYER`, `END_LAYER`, `MAX_BATCH_SIZE`;
  - node agent `AUTO_RESTART`, `RESTART_JOIN_DELAY_S`, `POOL_DIR`, `POOL_NODE_ENV`, `PEER_ID_FILE`,
    `NOTIFY_PORT`, `SWAP_GROWTH_MB`, `SWAP_WINDOW_S`.

## Verification (local, 6 Nov 2026)

| Suite | Result |
|---|---|
| Gateway (`pnpm --filter @gpupool/gateway test`) | 99 passed |
| Gateway local demo | 2 passed |
| Node agent (`pytest`) | 20 passed |
| Parallax hooks (`pytest pool/hooks`, with `PARALLAX_SRC` pin) | 11 passed |
| Arkiv | 10 passed |
| Contracts (`forge test`) | 17 passed |
| Pool scripts | `bash -n` OK; `DRY_RUN=1` commands checked; `pools-up.sh` dry run against a fake plan |

Shared tests: 41 of 43 pass. The 2 failures (ledger event type list) and 8 gateway typecheck errors
in `gateway/src/verification.ts` come from the separate 16.2 change, not from 16.1.

**Not verified on the real 3-node pool:**
- that the hooks load (`gpupool hooks: patched …` in `pool/logs/*.log`);
- a live failover with `continue_final_message`;
- a live restart, IP change, admission, route log, pool formation, and a second pool.

Keep starting joins within 30 s until the grace hook is confirmed live.

---

# 16.3 solving report (incentives and reputation)

Details: SPEC §8.8. Code: `gateway/src/incentives.ts`. Demo: `pnpm --filter @gpupool/gateway demo:incentives`.
All items built on the MVP ledger (SQLite working copy + an HCS event for every balance change); the
90/5/5 split, cost formula and self-request rule are unchanged.

| Item | Before | After |
|---|---|---|
| Vesting | Earned credits spendable at once | Locked 1 h (`vesting_s`), counted in the ratio at once, oldest lot spent first |
| Fraud penalties and bans | None | After a **final** 16.2 verdict: owners of high-risk route nodes lose locked credits (to the reserve) and the nullifier is banned |
| Stage blame | Whole route failed | Only nodes with a late heartbeat when the stalled stage is known |
| Expiry of earned credits | Never | 90 days after unlock, oldest first, never below running holds |
| Collusion detection | None | Flags: dominant requester, mutual flow, twin accounts (no automatic penalty) |
| Node cap | Fixed 3 | 3 → 5 for proven accounts (age, Orb/Passport, reliability, work); banned = 0 |
| Passport tier | Orb / Selfie only | Passport accepted; strongest credential kept |
| Agent Pass | None | Agent keys with a budget spend the human's credits (real AgentKit proof not integrated) |
| Routing preferences | None | Pin a pool, minimum reliability, private pools |
| Availability rewards | None | Standby credits from the reserve in pools with a queue, capped |

**Tests:** `gateway/test/incentives.test.ts` (14): vesting, spend order, expiry vs holds, penalties
(only blamed owner, once, no evidence), clawback, node cap, collusion flags, availability (+cap), stage
blame, agent keys, routing preferences, reserve booking. Shared event examples now cover all 16 event types.

**Not done:** real World AgentKit/Passport against the live API; region/latency routing preferences; any
automatic penalty from collusion flags; live run on the 3-node pool. Schema is version 10: delete the dev database.
