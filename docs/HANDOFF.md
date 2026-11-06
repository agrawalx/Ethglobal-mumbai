# HANDOFF: Full Context for Implementation Agents

**Read `CLAUDE.md` (rules) and then this file.** It gives a new agent (or teammate) all the context to start work. Then read `docs/SPEC.md` (the MVP specification). `docs/PROPOSAL.md` is the pitch. `docs/research/` has background only.

Writing standard: mostly ASD-STE100 (Simplified Technical English). Commands and code are exact.

---

## 1. Project in one paragraph

We build an open GPU pool network. People bring computers (gaming laptops, MacBooks). Near computers with low delay form a **pool**. A pool runs one AI model that no single computer can run. **Parallax** (GradientHQ, installed as a dependency, not forked) does the distributed inference. We build the layers on top: a **gateway** (OpenAI-compatible API, World ID login, x402 payments, a router that picks a pool for a model, a credit ledger), **Hedera** (HCS ledger log, x402 settlement, an HBAR payout contract), and **Arkiv** (public, self-expiring directory of nodes, pools, and models). The incentive layer is a BitTorrent-style contribution ratio with credits. Reputation measures reliability only.

**Event:** ETHGlobal Mumbai 2026. **Targets:** finalist + Hedera x402 track + World IDKit track + Arkiv track.

---

## 2. What we have proved already (measured, 5–6 Nov 2026)

Person 2 OpenCode work on `api` (6 Nov): context-limit reporting and floating credit
pricing are implemented locally. See `docs/OPENCODE.md` for the contract, pricing
formula, pending hardware measurements and live acceptance runs. SQLite schema is
15. Verification after integration: gateway 171 tests, node-agent 24 tests, shared 60 tests, Arkiv 10
tests; gateway/shared/Arkiv typechecks pass. These are local fixtures. The automatic
memory-based launch limit still needs live calibration; Mac launch limits have not
been raised. No new live pool or public-chain evidence is claimed.

### 2.1 Results

| # | Result | Evidence |
|---|---|---|
| P1 | Parallax runs on the Linux RTX 4060 laptop | Qwen3-0.6B, ~135 tok/s, scheduler + node on one machine |
| P2 | llama.cpp baseline on the 4060 | Qwen2.5-7B Q4_K_M: 53.5 tok/s generation, 2596 tok/s prefill (98% of the bandwidth limit) |
| P3 | A Mac joins a Linux scheduler over the LAN | M4 MacBook Air joined with full hardware info, MLX backend |
| P4 | Request through the Linux scheduler, served by the Mac | Qwen3-8B (MLX 8-bit), 96 tokens in 12.2 s ≈ 7.9 tok/s |
| P5 | **One model split across Mac + NVIDIA** | **Qwen3-14B: M4 layers [0,29) (MLX 8-bit) + 4060 layers [29,40) (FP8).** Coherent output. Neither machine can run it alone. |
| P6 | Memory pressure is the cause of stalls on 16 GB Macs | Baseline: 2.7 GiB swap-in during a run, 12 stalls > 400 ms, 3.2 tok/s |
| P7 | Low-KV fix works | Mac `--kv-cache-memory-fraction 0.25 --max-sequence-length 4096`: swap-in 0.32 GiB, 2 stalls, **5.2–6.0 tok/s**, TTFT 0.65–1.2 s |
| P8 | Agent bridge between Linux Claude and Mac Codex | WebSocket relay over an SSH tunnel; used for all Mac coordination |

### 2.2 Problems found and their fixes (apply all of them)

| Problem | Fix |
|---|---|
| Parallax needs `nvcc` on CUDA nodes (FlashInfer/deep_gemm JIT) | Install into the Parallax venv: `uv pip install --python .venv/bin/python "nvidia-cuda-nvcc==13.0.*" "nvidia-cuda-cccl==13.0.*" "nvidia-nvvm==13.0.*" "nvidia-cuda-crt==13.0.*"`. Create symlinks `nvidia/cu13/lib64 -> lib` and `lib/libcudart.so -> libcudart.so.13`. Export `CUDA_HOME=<venv>/lib/python3.12/site-packages/nvidia/cu13` and add `$CUDA_HOME/bin` to `PATH`. |
| Parallax uploads package info to Gradient by default | Always pass `-u`. |
| Default network name `gradient` is shared by every Parallax user on the LAN | Always pass a private `--dht-prefix`. |
| Scheduler identity persists in `p2p.key` (in the cwd of `parallax run`) | Delete or rotate it to get a new scheduler peer ID. |
| Docker bridge IPs are advertised | Pass `--announce-maddrs /ip4/<lan-ip>/tcp/<port> /ip4/<lan-ip>/udp/<port>/quic-v1`. |
| Random ports cannot pass the firewall | Pass fixed `--tcp-port` / `--udp-port`. Open them in `ufw` only for pool member IPs. |
| **Ghost nodes**: killed parents leave child processes that keep heartbeating | Stop the **whole process group** (`setsid` to start; kill every `parallax/.venv/bin/python` process, including `spawn_main` and `resource_tracker`). |
| **First node dropped at placement**: a node that waits > 30 s for its layer assignment has a stale heartbeat and is removed at bootstrap | Start all node joins **within 30 s** of each other. (Post-MVP: launcher hook.) |
| Nodes give up after 5 min without an assignment (`launch.py max_wait_time = 300`) | Same: synchronized joins. |
| A model download during join fills the link → heartbeat timeouts | Download the model **before** joining; then use `HF_HUB_OFFLINE=1`. |
| Scheduler needs model config files even when nodes are offline | Do **not** set `HF_HUB_OFFLINE=1` on the scheduler (it downloads small config files). |
| Mac had a pre-release `httpx 1.0.dev6` → `TypeError` in `p2p/server.py` | Pin `httpx>=0.26,<0.29` (0.28.1 works). |
| Mac Ethernet adapter reconnect → new DHCP IP; half-dead node | Restart Parallax on IP change; update firewall and `--announce-maddrs`. |
| After a messy re-placement, forwards hang (stale peer state) | Do a clean synchronized restart of all nodes. |
| Logprobs are rejected by Parallax (`_validate_supported_sampling_params`) | Do not send `logprobs`. Future verification uses a separate scoring engine. |
| Qwen3 thinking mode is on by default | Send `"chat_template_kwargs": {"enable_thinking": false}`. |
| Parallax backend API has no auth, CORS `*`, open `/weight/refit` | Keep port 3001 on `127.0.0.1`. Only the gateway calls it. |

### 2.3 Parallax facts (from source, commit `162354a`, Lattica 1.0.21, SGLang 0.5.12)

- `parallax run -m <model> -n <nodes>` starts the scheduler (HTTP `127.0.0.1:3001`). `parallax join` starts a node.
- Useful HTTP: `POST /v1/chat/completions`, `GET /cluster/status_json` (nodes and status; **no layer ranges**, see §9), `GET /v1/models`.
- Model catalog is fixed in `src/backend/server/static_config.py`; each GPU model maps to an MLX variant for Macs.
- Node memory: `--param-mem-ratio` (default 0.65), `--kvcache-mem-ratio` (0.25). Mac MLX actual KV: `--kv-cache-memory-fraction`.
- Placement prefers the fewest stages; a model that fits on one node is not split.
- Leave detection: 30 s heartbeat timeout. Uncovered layers trigger a global rebalance (all nodes reload).
- No mid-request recovery. See `docs/research/parallax-membership-and-failover.md`.
- `--notify-url` on nodes posts per-step `{session_id, step_id, block_idx, total_blocks, status}` (post-MVP cross-check).

---

## 3. Environment as of 6 Nov 2026 (check before use; IPs change)

| Item | Value |
|---|---|
| Venue LAN | Wired `10.73.0.0/16`, gateway `10.73.0.1`. Venue Wi-Fi is isolated and slow (190–550 ms); do not use it. |
| Linux laptop (coordinator + node, 4060 8 GB) | `10.73.185.71`, user `yash`, Parallax at `~/parallax` (venv `.venv`), models for llama.cpp in `~/models`, Qwen3-14B-FP8 in HF cache |
| Mac M4 16 GB (node) | Last IP `10.73.73.218` (changed twice; check with `ifconfig`). Adapter is 100 Mbps. Parallax at `~/Desktop/ETHGlobal/parallax`. 8B MLX cache in `~/.cache/huggingface`; 14B MLX cache in `<parallax>/.cache/huggingface` |
| Mac M5 16 GB (node 3) | Not set up yet |
| Windows laptop (no NVIDIA GPU) | `10.73.84.181`. Use as the **requester laptop** for the demo |
| Ports | Scheduler 5100, Linux node 5101, Mac nodes 5102, 5103 (TCP+UDP) |
| Private network name | `gpupool-x7k2` |
| Agent bridge | Relay on Linux `127.0.0.1:8765`, room `ethglobal`, agents `claude` (Linux) and `codex` (Mac). Code: `~/agent-bridge-src/agent-bridge`. Mac connects by SSH tunnel with a restricted key (`~/.ssh/authorized_keys`, `from=` must list the Mac IP). |
| Hedera testnet (public IDs) | Operator = treasury `0.0.11331600`; settler `0.0.11332602` (`0x14ff4f7615ef8e3cca82adf879f3be4051780a94`); agent `0.0.11332604`; provider payout accounts `0.0.11332605`–`0.0.11332607`; HCS topic `gpupool-ledger` = `0.0.11332608`. Keys in git-ignored `keys.txt` and `.env` files. |
| `EpochPayout` (testnet) | `0x22aafc9cbdafd4e5a7e7eae47b27cad48ad8b82c` = `0.0.11332808`, settler `0x14ff…0a94`, `claimDelay` 60 s, `sweepDelay` 7 days. Deploy tx `0x66ac3aeb794a2c739c61960ac336e351c0e44eaad54be2685873d221707163db`. Verified on Sourcify (exact match): https://hashscan.io/testnet/contract/0.0.11332808 |
| Arkiv wallets (public) | Gateway `0xfeb19eb223236427a31b2d909851025abc55db1b`; coordinator pool key `0x181aff3abf57d640bd9d10f4cb03471c55e9094e` (`~/.gpupool/pool.key`); Linux node key `0x4f24a8795047c2bb0d0c542780dc1d91f7f8cdc1` (`~/.gpupool/node.key`). Mac node keys: created by `gpupool-node init`. |
| World app (public) | App `app_3defa81f175967a96109b1a628927bb6`, RP `rp_831104fa5fd04dd5`, action `gpupool-account`, staging. |

### 3.1 Known-good commands

**Scheduler (coordinator, Linux):**
```bash
cd ~/parallax && source .venv/bin/activate
setsid parallax run -m Qwen/Qwen3-14B-FP8 -n 3 -u --dht-prefix gpupool-x7k2 \
  --tcp-port 5100 --udp-port 5100 \
  --announce-maddrs /ip4/10.73.185.71/tcp/5100 /ip4/10.73.185.71/udp/5100/quic-v1
```

**Linux node (4060):**
```bash
cd ~/parallax && source .venv/bin/activate
export CUDA_HOME=$PWD/.venv/lib/python3.12/site-packages/nvidia/cu13 PATH=$CUDA_HOME/bin:$PATH
HF_HUB_OFFLINE=1 setsid parallax join -u --dht-prefix gpupool-x7k2 --tcp-port 5101 --udp-port 5101 \
  --announce-maddrs /ip4/10.73.185.71/tcp/5101 /ip4/10.73.185.71/udp/5101/quic-v1
```

**Mac node (M4 / M5):**
```bash
cd ~/Desktop/ETHGlobal/parallax && source .venv/bin/activate
HF_HOME=<cache with the 14B MLX model> HF_HUB_OFFLINE=1 parallax join -u --dht-prefix gpupool-x7k2 \
  --tcp-port 5102 --udp-port 5102 \
  --announce-maddrs /ip4/<mac-ip>/tcp/5102 /ip4/<mac-ip>/udp/5102/quic-v1 \
  --kv-cache-memory-fraction 0.25 --max-sequence-length 4096
```

**Test request:**
```bash
curl -s http://127.0.0.1:3001/v1/chat/completions -H 'Content-Type: application/json' \
  -d '{"messages":[{"role":"user","content":"Say hello"}],"max_tokens":32,"stream":false,"chat_template_kwargs":{"enable_thinking":false}}'
```

---

## 4. Repository structure

```
Ethglobal-mumbai/
├── AGENTS.md / CLAUDE.md   → pointer to this file
├── README.md
├── .gitignore
├── docs/
│   ├── HANDOFF.md          ← this file
│   ├── SPEC.md             ← MVP specification (source of truth for behaviour)
│   ├── PROPOSAL.md         ← pitch (ASD-STE100)
│   └── research/           ← background, not requirements
├── shared/                 ← Step 0 interfaces: TS types + JSON examples (API, HCS events, Arkiv entities, Merkle leaf, config)
├── pool/                   ← C1: scripts to start/stop/status the Parallax pool; node.env.example
├── node-agent/             ← C2: Python node agent (key, registration, Arkiv listing, heartbeat)
├── gateway/                ← C3–C6: TypeScript gateway (API, World login, x402, router, ledger, HCS, settlement job)
├── contracts/              ← C10: EpochPayout.sol (Foundry)
├── agent-client/           ← C9: x402 paying AI agent script
├── frontend/               ← C8: Next.js app
├── arkiv/                  ← Arkiv track files (schema.md, friction.md, reach.md, why-arkiv.md, how-you-use-arkiv.md)
└── scripts/                ← dev helpers (demo runner, seed data)
```

---

## 5. End-to-end implementation plan (in order)

Each step has an owner stream (see `docs/SPEC.md` §2.1 and the parallel plan in §6), an output, and a "done when" check. Steps in the same phase can run in parallel.

### Phase 0: Interfaces (do first, ~1 hour, everyone)

| Step | Work | Done when |
|---|---|---|
| 0.1 | Write `shared/` types: gateway API request/response, session JWT claims, HCS event union, Arkiv entity schemas, Merkle leaf format, config (models, factors, prices, epoch length) | Types compile; one JSON example per type |
| 0.2 | Create Hedera testnet accounts (treasury, operator, settler, agent, 3 provider payout accounts); create HCS topic | IDs in `.env` files |
| 0.3 | World Developer Portal: app, RP, action `gpupool-account` (staging); save the RP signing key | IDs in `gateway/.env` |
| 0.4 | Arkiv: wallets for gateway, coordinator, each node; faucet; access key | Keys in `.env` files |

### Phase 1: Foundations (parallel)

| Step | Stream | Work | Done when |
|---|---|---|---|
| 1.1 | A Inference | Set up the M5 as node 3 (same as M4). Write `pool/start-scheduler.sh`, `pool/join-node.sh` (reads `node.env`), `pool/stop-all.sh` (process group), `pool/status.sh` | 3-node pool serves Qwen3-14B; warm-up works on `127.0.0.1:3001` |
| 1.2 | B Gateway | Gateway skeleton: `/v1/chat/completions` proxy with streaming to the pool; `/v1/models`; config loader; SQLite schema (SPEC §8.7) | Requester laptop gets an answer through the gateway |
| 1.3 | E Contract | `EpochPayout.sol` + Foundry tests (post, claim, double-claim, bad proof, tinybar units) + testnet deploy via Hashio | Contract verified on HashScan |
| 1.4 | F Arkiv | Entity schemas; writer + extender helper; seed `gpupool.model` catalog; a query that returns ready pools for a model | Seeded entities visible; query runs |
| 1.5 | G Frontend | Next.js app with all pages on mock data from `shared/` examples | Pages render with mocks |
| 1.6 | D Hedera | x402 proof of concept: paywalled `/echo` endpoint + agent pays on testnet | Settled payment tx ID |

### Phase 2: Core flows (parallel, after 1.2)

| Step | Stream | Work | Done when |
|---|---|---|---|
| 2.1 | C Identity | World login: `/auth/world/rp-signature`, `/auth/world/verify`, accounts table, starter credits, JWT; IDKit widget in frontend | Success, duplicate-rejected, and cancel paths work |
| 2.2 | B Gateway | Credit ledger: hold, settle, split (90/5/5), self-request rule, receipts; route from node heartbeats (SPEC §5.5) | Balances change correctly in a test |
| 2.3 | D Hedera | HCS event writer (async, signed); `ledger_events.hcs_seq` filled | Events visible on HashScan |
| 2.4 | D Hedera | x402 in the gateway for requests without a session; agent client (budget cap) | Agent gets answers; payments recorded |
| 2.5 | A + F | Node agent: key, registration link, Arkiv node listing (extend every 30 s), heartbeat to gateway; coordinator writes `gpupool.pool` | Stopped node disappears from Arkiv after expiry |

### Phase 3: Router, reputation, payouts

Step 3.1 implemented: gateway `src/router.ts` reads Arkiv models and ready pools, checks the private
coordinator URL hash and fresh registered member heartbeats, and scores by minimum stored reliability
and active request load. Both credit and x402 paths capture the selected pool's heartbeat layer map.
No pool / Arkiv outage returns 503 + Retry-After before payment; discovery has no Parallax fallback.
Load and URL mapping rules: SPEC §5.4; run instructions: `gateway/README.md` "Arkiv routing".
Validation: `pnpm --filter @gpupool/gateway test` (50 passed), shared tests (41 passed), Arkiv
tests (10 passed), and typechecks for all three packages passed. Read-only live `list-models`
returned both Qwen3-8B-FP8 and Qwen3-14B-FP8 from Rabdi. Live three-node inference through the
router remains unverified.

Step 3.2 implemented: persisted seven-day request/heartbeat observations drive reliability scores
(70% success / 30% uptime), refreshed on events, account reads, and a periodic timer. `/me` and
node heartbeat responses expose the score; node agents publish it on their existing Arkiv cadence.
MVP defaults confirmed: missing rates use 0.8; online heartbeats count once per 10-second slot.
One inference slot per pool; waiting requests sort by account contribution ratio, x402 ratio 1,
FIFO ties. Queue cancellation and failed preparation release the slot without charging waiters.
Admission rechecks Arkiv and fresh heartbeats. Schema version is 3; use a fresh development DB
(no migrations; existing v2 files are not deleted automatically). Validation: gateway tests
(59 passed), including priority ordering, queued cancellation, stale admission, rolling-window
expiry, restart persistence, and rollback on reliability-write failure; gateway typecheck passed. Live three-node load is unverified.
Step 3.3 backend implemented: epoch close, immutable provider snapshots, BigInt provider amounts,
Merkle proofs, HCS-before-funding, treasury-to-settler funding, durable signed transactions, payable
posting, proof/status API, claim/sweep log indexing, and provider claim CLI (preview by default).
Validation: `pnpm --filter @gpupool/gateway test` (71 passed), shared schema tests (42 passed),
`forge test -vv` in contracts (17 passed), gateway/shared typechecks, and diff whitespace checks.
Tests include actual ECDSA transaction signing against a fake Hedera RPC, persisted transaction
retry, Solidity-compatible proofs, claim delays, and claim/sweep event synchronization.
See `gateway/README.md` "Epoch settlement and provider payouts". SQLite schema is now 4; older
local development databases need recreation. No live money-moving transaction has been executed
for this change; live testnet posting/claim evidence and the frontend claim page remain unverified.

Remaining backend API/read-path work implemented: `/network`, `/ledger/events`, and background
Arkiv account-stat publishing every ten minutes (one-day TTL, owner-scoped writer, no per-request
writes or private World data). Proof/status API remains `/payouts/:address`. No schema change beyond
version 4. Reproducible local demo: `pnpm --filter @gpupool/gateway test:demo` (two fixture runs).
User explicitly deferred live-environment verification; no runtime .env files or local gateway/pool
were available in this checkout. `gateway/scripts/verify-backend.ts` is prepared for that later check.
Local validation completed: gateway tests (79 passed), shared schema tests (42 passed), Arkiv tests
(10 passed), Solidity tests (17 passed); gateway, Arkiv and shared typechecks passed. Both complete
local demo runs passed. These 148 tests use local service/wallet fixtures; they do not certify live
World login, real three-machine inference, or public-chain payouts. The frontend and real three-node/
public-testnet demo evidence remain separate pending work, with live verification explicitly deferred.

Post-MVP P5 (serving resilience, `docs/POST_MVP_PLAN.md`) implemented on branch `backendXoutofscope`:
stall detection + failover, Parallax runtime hooks (`pool/hooks`), clean restarts, IP change, memory
checks, exact route, cross-check. Local tests only (gateway 94, node agent 17, hooks 8); live pool
verification pending. Gateway SQLite schema is 6: recreate the development DB.

| Step | Stream | Work | Done when |
|---|---|---|---|
| 3.1 | B + F | Router reads `gpupool.pool` from Arkiv; score = reliability × (1 − load); 503 when none | Model list and routing come from Arkiv |
| 3.2 | B | Reliability score (success 0.7 + uptime 0.3); pool score = min node score; priority queue by ratio | Scores visible on `/me` |
| 3.3 | E + D | Settlement job: epoch close → Merkle tree → HCS `epoch_closed` → `postEpoch` with HBAR; proofs API; claim page | A provider claims HBAR on HashScan |
| 3.4 | G | Wire all frontend pages to real APIs and Arkiv | No mocks left |

### Phase 4: Demo and submission

| Step | Work | Done when |
|---|---|---|
| 4.1 | Full demo dry run from the Windows laptop (SPEC §1.1, 9 steps) | Runs twice without manual fixes |
| 4.2 | Track files: Hedera README (x402 tx ID, HashScan links), World debrief, `/arkiv/*.md` + writer wallets + one runnable query | Files complete |
| 4.3 | Demo video ≤ 5 min; submission | Submitted before the deadline |

---

## 6. Who does what (suggested)

| Owner | Streams |
|---|---|
| Linux (Claude + Yash) | B gateway core + ledger; then help integrate C/D |
| Mac (Codex) | A pool scripts + M5 + node agent; then F Arkiv writer in the node agent |
| Person C | D x402 + HCS + agent client; E contract + settlement |
| Person D | C World login; G frontend; Arkiv reads in the UI |

---

## 7. Rules for agents working in this repo

1. `docs/SPEC.md` is the source of truth for behaviour. If you change behaviour, update the spec in the same commit.
2. Build the MVP only. Out-of-scope items are in `docs/SPEC.md` §16. Do not build them. Do not design against them.
3. Never commit secrets. Use `.env` files (ignored). Update the matching `.env.example` when you add a key.
4. Never expose the Parallax API (port 3001) outside `127.0.0.1`.
5. Never fork Parallax into this repo. Use it as an installed dependency. Small runtime hooks go in `pool/`.
6. Stop Parallax by process group. Check `pgrep -f "parallax/.venv/bin/python"` is empty after a stop.
7. Coordinate Mac work through the agent bridge (`./bridge send --to codex …`). Include a task ID and acceptance criteria.
8. Confirm unknowns before you build on them (x402 Hedera package/API, testnet USDC, Arkiv extend API names, World Agent Pass).

---

## 8. Environment keys

Self-service onboarding is `/getting-started`; read `docs/PROVIDER-ONBOARDING.md`.
Native helpers use a central gateway through scoped outbound relays, not the older SSH
bootstrap's co-located gateway. `PUBLIC_URL` must be the reachable HTTPS API URL. New optional
central-only keys: `PROVIDER_ARKIV_FUNDER_KEY` (dedicated Rabdi gas wallet) and
`PROVIDER_ARKIV_GRANT_WEI` (default 0.01 tGLM, maximum 1 per node, 0 disables).
SQLite is schema 13. Helpers never receive World/HCS/treasury/settler/funder keys.

Pool onboarding can now use `pool/kickstart.sh setup <manifest>` with the gateway on the
coordinator. See `docs/POOL-KICKSTART.md` and `pool/pool.example.json`. The manifest discovers
Ethernet IPs from enrolled SSH hosts; no new process env keys are introduced. Generated
node/scheduler/agent env files use the existing keys below. Operator gateway credentials
stay on the coordinator. The bootstrap is locally tested; live four-host acceptance is pending.

Each component has a `.env.example`. Copy it to `.env` and fill it. Summary:

### gateway/.env
| Key | Purpose |
|---|---|
| `PORT` | Gateway HTTP port (e.g. 8080) |
| `HOST` | Bind address (default `0.0.0.0`; the gateway is the public entry point) |
| `PUBLIC_URL` | URL that the requester laptop uses (e.g. `http://10.73.185.71:8080`) |
| `POOL_COORDINATOR_URL` | Private Parallax scheduler API (`http://127.0.0.1:3001`); exact URL must hash to the Arkiv pool listing's `coordinator_url_hash` |
| `DATABASE_PATH` | SQLite file path |
| `DB_RESET_ON_MISMATCH` | Default `true`: a database from another schema version is moved aside as `<file>-bak-v<N>-<time>` (never deleted) and recreated on the latest schema. `false` = refuse to start |
| `VERIFY_SESSION_TOKEN` | Optional verification CLI session token for an idle requester account; only `--inference` spends credits; server does not use it |
| `HEARTBEAT_SECONDS` | Expected node heartbeat interval / score refresh period (default `10`); must match node-agent configuration |
| `POOL_TIMEOUT_MS` | Time to the pool response headers of **non-streaming** requests, ms (default `600000`; generation after the headers is not timed). Streaming requests use the first-token limit from `shared/config` `resilience` (post-MVP P5.1). |
| `JWT_SECRET` | Signs session tokens |
| `GATEWAY_SIGNING_KEY` | ed25519 private key; signs receipts and HCS events |
| `CORS_ORIGINS` | Frontend origin(s), comma-separated. Vite dev default `http://localhost:5173`; add the URL the requester laptop uses. Empty = every browser call is blocked. |
| `WORLD_APP_ID` | World Developer Portal app ID |
| `WORLD_RP_ID` | RP ID (used in the verify URL) |
| `WORLD_RP_SIGNING_KEY` | RP signing key (server only) |
| `WORLD_ACTION` | `gpupool-account` |
| `WORLD_ENVIRONMENT` | `staging` |
| `STARTER_CREDITS` | e.g. `10000` |
| `STARTER_EXPIRY_DAYS` | e.g. `14` |
| `HEDERA_NETWORK` | `testnet` |
| `HEDERA_OPERATOR_ID` / `HEDERA_OPERATOR_KEY` | Pays HCS fees; holds the topic submit key |
| `HCS_TOPIC_ID` | Ledger topic |
| `HEDERA_MIRROR_URL` | `https://testnet.mirrornode.hedera.com` |
| `HEDERA_JSON_RPC_URL` | `https://testnet.hashio.io/api` |
| `HEDERA_CHAIN_ID` | `296` |
| `TREASURY_ACCOUNT_ID` / `TREASURY_PRIVATE_KEY` | Receives x402; funds epoch payouts |
| `X402_FACILITATOR_URL` | `https://x402.org/facilitator` (supports `hedera:testnet`, confirmed; see `scripts/x402-poc/README.md`) |
| `X402_NETWORK` | `hedera:testnet` (CAIP-2 ID of `@x402/hedera` 2.30) |
| `X402_PAY_TO` | Treasury account |
| `SETTLER_PRIVATE_KEY` | Calls `postEpoch` |
| `PAYOUT_CONTRACT_ADDRESS` | Deployed `EpochPayout` |
| `EPOCH_SECONDS` | `600` for the demo |
| `ARKIV_RPC_URL` | `https://rpc.rabdi.db-chain.testnet.arkiv.network` |
| `ARKIV_CHAIN_ID` | `7794095` |
| `ARKIV_ACCESS_KEY` | From hub.arkiv.network |
| `ARKIV_PRIVATE_KEY` | Gateway writer; enables background account-stat publishing (startup, then every 600 s); not needed for read-only APIs |
| `PARALLAX_ALLOWED_PEERS_FILE` | Post-MVP P5.4: absolute path where the gateway writes the admission allow-list (peer IDs of registered nodes with a fresh heartbeat). Same file as the scheduler's `ALLOWED_PEERS_FILE`. Empty = off |
| `POOL_COORDINATORS` | SPEC §16.1 many pools: JSON `{"pool-id": "http://127.0.0.1:3102"}`; other pools use `POOL_COORDINATOR_URL` |
| `POOL_COORDINATORS_FILE` | Same map as a file; `pool/pools-up.sh` writes `<repo>/pool/run/coordinators.json` |
| `TRANSCRIPT_KEY` | Privacy (SPEC §5.6): AES-256-GCM key for transcripts at rest, 64 hex chars (`openssl rand -hex 32`). Empty = plain text (MVP) |
| `TLS_CERT_FILE` / `TLS_KEY_FILE` | Privacy: PEM certificate + key; the gateway then serves HTTPS. Both empty = HTTP |
| `PRIVATE_POOLS` | SPEC §16.3 private pools: JSON `{"pool-id": ["acc_…"]}`; the pool's node owners may always use it |
| `TRUSTED_ACCOUNTS` | SPEC §16.1 privacy: comma-separated `acc_` IDs trusted with the first/last layers |
| `PARALLAX_ROUTE_LOG` | Post-MVP P5.8/P5.9: absolute path of the hook route log (`<repo>/pool/run/routes.jsonl`). Set **only** when the scheduler runs with `pool/hooks` (`HOOKS=1`): the gateway then tags requests with `gpupool_req_id`. Empty = off |
| `TOOLS_MODE` | Tool calling for OpenAI clients such as OpenCode. `emulate` (default): the gateway puts `tools` into the system prompt in Qwen3 format and parses `<tool_call>` text back into OpenAI `tool_calls`. `native`: `tools` go to Parallax unchanged |
| `VERIFICATION_ENABLED` | SPEC §16.2: `false` (default). Output verification is planned, not active: no sampled checks, canaries, capability challenges, penalties or `/verifications` routes. |
| `VERIFIER_URL` / `VERIFIER_OWNER_ACCOUNT` | P6.1: trusted Token-DiFR reference service and its owner account; sampled checks stay disabled unless both are set |
| `VERIFIER_SECONDARY_URL` / `VERIFIER_SECONDARY_OWNER_ACCOUNT` | P6.3: independent reference service and owner for appeals |
| `VERIFICATION_MAX_RATE` / `VERIFICATION_MIN_RATE` / `VERIFICATION_COST_MC` | P6.2: sample-rate bounds and estimated cost used for pool checks |
| `VERIFICATION_APPEAL_HOURS` | P6.3: time for an owner to request a second check; default 24 hours |

### pool/node.env (one per node; also used by the coordinator)
| Key | Purpose |
|---|---|
| `PARALLAX_DIR` | Parallax checkout |
| `ROLE` | `scheduler` or `node` |
| `MODEL` | e.g. `Qwen/Qwen3-14B-FP8` |
| `INIT_NODES` | Number of nodes (scheduler only), e.g. `3` |
| `DHT_PREFIX` | Private network name |
| `LAN_IP` | This machine's wired IP |
| `TCP_PORT` / `UDP_PORT` | Fixed ports |
| `HF_HOME` | Model cache directory |
| `EXTRA_FLAGS` | e.g. Mac `--kv-cache-memory-fraction 0.25 --max-sequence-length 4096` |
| `CUDA_HOME` | CUDA nodes only |
| `HOOKS` | Post-MVP P5: `1` (default) loads `pool/hooks` (grace hook, ghost guard, route log, peer ID file); `0` = plain Parallax |
| `NOTIFY_PORT` | Post-MVP P5.9: node agent listener for Parallax `--notify-url` (e.g. `5190`); empty = off |
| `ALLOWED_PEERS_FILE` | Post-MVP P5.4, scheduler only: admission allow-list written by the gateway; empty = off. With it on, a node joins only after its agent has sent a heartbeat with its peer ID |
| `API_PORT` / `PROCESS_NAME` | Scheduler only (§16.1 many pools): private API port (default 3001) and process name (default `scheduler`); `pools-up.sh` sets them |
| `REBALANCE_COOLDOWN_S` | Scheduler only (§16.1): wait before Parallax reloads all nodes after a leave (default 60) |
| `SCHEDULER_ADDR` / `RELAY_SERVERS` / `INITIAL_PEERS` | §16.1 WAN: scheduler multiaddr and our own relay / bootstrap multiaddrs; empty = LAN (MVP) |
| `START_LAYER` / `END_LAYER` | §16.1 privacy: pin this node to `[start, end)` (pin all nodes of the pool: Parallax does not rebalance mixed pools) |
| `MAX_BATCH_SIZE` | §16.1 batching: Parallax `--max-batch-size` (Parallax default 8; managed pools: `node_batching.max_batch_size`, 4) |
| `MICRO_BATCH_RATIO` | §16.1 batching: Parallax `--micro-batch-ratio`, micro batch = `MAX_BATCH_SIZE / ratio` (Parallax default 1; managed pools 2) |
| `SCHEDULER_WAIT_MS` | §16.1 batching: Parallax `--scheduler-wait-ms`, time to gather a batch (Parallax default 500; managed pools 50) |
| `ALLOW_DEBUG_LOGS` | Privacy: `1` allows `--verbose` / `--log-level debug` (Parallax then logs prompts); default refused |
| `ALLOW_MAC_DEFAULT_MEMORY` | Post-MVP P5.7: `1` lets a Mac start without the memory flags (not recommended) |

The coordinator runs both roles: `pool/scheduler.env` (`ROLE=scheduler`, ports 5100) and `pool/node.env` (`ROLE=node`, 5101). `pool/*.env` is git-ignored.

### node-agent/.env
| Key | Purpose |
|---|---|
| `GATEWAY_URL` | Gateway URL |
| `NODE_KEY_PATH` | Node EVM key file (`~/.gpupool/node.key`) |
| `POOL_ID` | Pool this node belongs to |
| `IS_COORDINATOR` | `true` on the coordinator (writes `gpupool.pool`) |
| `POOL_KEY_PATH` | Coordinator only: pool listing key |
| `FRONTEND_URL` | Base of the registration link printed by `gpupool-node init` |
| `COORDINATOR_URL` | Coordinator only: hashed into `gpupool.pool.coordinator_url_hash` (default `http://127.0.0.1:3001`) |
| `PARALLAX_NODE_LOG` | Parallax node log the agent reads its layer range from (default `pool/logs/node.log`) |
| `ARKIV_RPC_URL` / `ARKIV_CHAIN_ID` / `ARKIV_ACCESS_KEY` | Arkiv access |
| `HEARTBEAT_SECONDS` / `ARKIV_EXTEND_SECONDS` | `10` / `30` |
| `AUTO_RESTART` | Post-MVP P5.5/P5.6: `true` = run `pool/restart.sh` when the gateway orders a pool restart or the LAN IP changes; default `false` (prints the command) |
| `RESTART_JOIN_DELAY_S` | Members wait this long before rejoining after a restart, so the scheduler is up (default `15`) |
| `POOL_DIR` / `POOL_NODE_ENV` / `PEER_ID_FILE` | Defaults `<repo>/pool`, `pool/node.env`, `pool/run/node.peer-id` |
| `NOTIFY_PORT` | Default: the value in `pool/node.env` |
| `SWAP_GROWTH_MB` / `SWAP_WINDOW_S` | Post-MVP P5.7: report `swap_growing` when swap use grows more than this within the window while serving (default `256` / `300`) |

### contracts/.env
| Key | Purpose |
|---|---|
| `HEDERA_JSON_RPC_URL` | Hashio testnet relay |
| `DEPLOYER_PRIVATE_KEY` | Deploys the contract (ECDSA) |
| `SETTLER_ADDRESS` | EVM address allowed to post epochs |
| `CLAIM_DELAY_SECONDS` | `0`–`300` for the demo |
| `SWEEP_DELAY_SECONDS` | Settler can sweep unclaimed HBAR back after this (default `604800`, 7 days) |

### arkiv/.env (CLI `arkiv/src/cli.ts`; the node agent calls it)
| Key | Purpose |
|---|---|
| `ARKIV_RPC_URL` / `ARKIV_CHAIN_ID` | Rabdi RPC / `7794095` |
| `ARKIV_ACCESS_KEY` | hub.arkiv.network access key (appended to the RPC URL path) |
| `ARKIV_PRIVATE_KEY` or `ARKIV_KEY_PATH` | Writer key (hex) or a key file (node agent: `NODE_KEY_PATH`; coordinator: `POOL_KEY_PATH`). Needs tGLM from the faucet. |
| `ARKIV_EXTEND_SECONDS` | `30` |

### scripts/x402-poc/.env
| Key | Purpose |
|---|---|
| `PORT` | PoC server port (`8090`) |
| `X402_FACILITATOR_URL` / `X402_NETWORK` / `X402_PAY_TO` | Same as gateway |
| `X402_POC_MODEL` / `X402_POC_MAX_TOKENS` | Which shared-config price tier `/echo` charges |
| `X402_POC_URL` | URL the client pays |
| `AGENT_ACCOUNT_ID` / `AGENT_PRIVATE_KEY` / `AGENT_BUDGET_HBAR` / `HEDERA_NETWORK` | Same as agent-client |
| `AGENT_KEY_TYPE` | `ecdsa` (default) or `ed25519` |
| `HASHSCAN_URL` | `https://hashscan.io/testnet` |

### agent-client/.env
| Key | Purpose |
|---|---|
| `GATEWAY_URL` | Gateway URL |
| `AGENT_ACCOUNT_ID` / `AGENT_PRIVATE_KEY` | Pays with x402 |
| `AGENT_BUDGET_HBAR` | Spending cap (the agent stops before a payment would exceed it) |
| `HEDERA_NETWORK` | `testnet` |
| `GPUPOOL_API_KEY` | `pnpm topup`: the API key (`gpa_…`) to buy credits for (1 testnet HBAR = 10 credits); `AGENT_ACCOUNT_ID` / `AGENT_PRIVATE_KEY` = the payer's Hedera Portal testnet account |
| `AGENT_KEY_TYPE` | `ecdsa` (default) or `ed25519`; only for a raw 64-hex `AGENT_PRIVATE_KEY` (a DER key carries its type) |

### gateway/.env.provider (CLI only; copy gateway/provider.env.example)
| Key | Purpose |
|---|---|
| `GATEWAY_URL` | Gateway payout proofs API |
| `PROVIDER_PRIVATE_KEY` | Provider's ECDSA claim key; private, never a frontend variable |
| `PAYOUT_CONTRACT_ADDRESS` | Confirmed testnet EpochPayout address |
| `HEDERA_JSON_RPC_URL` / `HEDERA_CHAIN_ID` / `HEDERA_NETWORK` | Testnet RPC / `296` / `testnet` |

### frontend/.env.local (Vite: only `VITE_*` keys reach the browser)
| Key | Purpose |
|---|---|
| `VITE_GATEWAY_URL` | Gateway URL (e.g. `http://10.73.185.71:8080`) |
| `VITE_WORLD_APP_ID` | World app ID (public) |
| `VITE_WORLD_ACTION` | `gpupool-account` |
| `VITE_HEDERA_RPC` | `https://testnet.hashio.io/api` (wallet claims) |
| `VITE_PAYOUT_ADDR` | Deployed EpochPayout address |
| `VITE_HCS_TOPIC` | HCS ledger topic ID (HashScan links) |
| `VITE_MIRROR_URL` | `https://testnet.mirrornode.hedera.com` |

**Never** put a private key or the World RP signing key in a `VITE_*` variable: Vite ships every `VITE_*` value to the browser.

---

## 9. Open questions (confirm before building on them)

| Question | Who/how |
|---|---|
| ~~Exact x402 Hedera package and API; which facilitator supports Hedera testnet~~ **Resolved:** `@x402/{core,hono,fetch,hedera}` 2.30.0 (x402 v2), network `hedera:testnet`, HBAR asset `0.0.0`, amounts in tinybars; x402.org facilitator supports it (no API key, pays fees). Details: `scripts/x402-poc/README.md`. Settled live: tx `0.0.9185802@1793929496.997341480`. | Done (step 1.6) |
| Testnet USDC availability (MVP uses HBAR) | Hedera booth |
| ~~Arkiv extend/update API names~~ **Resolved:** SDK 1.0.1: `createEntity`, `patchEntity`, `extendEntity` (sets expiry from now), `deleteEntity`, `executeBatch`, `select().from().where().fetch()`. No payload/annotations any more. Details: `arkiv/friction.md`, `arkiv/schema.md`. | Done (step 1.4) |
| Orb and `selfieCheck` availability in IDKit v4 staging; duplicate handling | **Partly resolved (step 2.1):** IDKit 4.6.0 has `selfieCheck` and Orb (`proof_of_human`); the verify API accepts a reused nullifier with HTTP 200 ("nullifier reuse"), so our UNIQUE nullifier is the duplicate guard. Open: does World App refuse a second proof for the same action (repeat login)? Staging needs the simulator. Details: `gateway/README.md` "World ID". |
| Does one human get the **same nullifier** for Orb and Selfie Check? (If not, one human can make two accounts.) | World booth |
| World Agent Pass definition (post-MVP) | World workshop |
| Partner-pick rule (Hedera + World + Arkiv = 3) | ETHGlobal |
| ~~`/cluster/status_json` has no layer ranges~~ **Resolved (step 2.2/2.5):** each node agent reads its own range from its Parallax node log (`Join scheduler response` / `Layer allocation changed` / `Reloading executor` lines) and reports it in its signed heartbeat; the gateway builds the layer map from fresh heartbeats and accepts it only if it covers `[0, num_layers)` exactly once (SPEC §5.5). No peer ID map is needed. | Done |
| Does Parallax honour `stream_options.include_usage`? If not, streaming requests have no `usage` to settle (they end `no_usage` and cost nothing). | Live test (needs the 3-node pool) |

## Live frontend integration

Main frontend copied into backendXoutofscope. It is Vite/React with public VITE variables, live-only data and shared-schema adapters. See LIVE-DEMO-RUNBOOK.md for service configuration, tests and acceptance gates. Previous Next.js/NEXT_PUBLIC instructions are obsolete for this frontend. No hardware or payment acceptance is implied by a code build.


### Pool request availability

`GET /pools/:pool_id/availability?model=<model-id>` reports `available`, `reason`, `action`, and `checked_at`. It uses the marketplace model catalog and the same pool eligibility checks as `/v1/models`. The provider and network views poll this endpoint; connected helpers and directory listing status do not by themselves mean requests can be routed. A directory read failure returns 503, so the UI shows availability as unknown and allows a retry. The check is a snapshot: a later request can still fail if pool state changes.
