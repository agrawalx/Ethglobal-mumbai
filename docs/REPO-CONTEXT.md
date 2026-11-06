# GPU Pool Network: current integration context

Updated 2026-11-06. Start here when continuing the frontend integration. Read `CLAUDE.md`, then the current `docs/SPEC.md` and `docs/LIVE-DEMO-RUNBOOK.md`. This document records code status and verification limits; it is not evidence of a completed live demo.

## Current branch and how it was assembled

- **Working branch:** `integration/live-frontend`.
- **Worktree:** `/private/tmp/gpupool-backend-live` (a temporary local path; keep or relocate it before cleaning temporary files).
- **Base:** `origin/backendXoutofscope` at `45cea98d542a3fff936c5b7824074d62a8bdd9b8`.
- **Frontend source:** tracked `frontend/` copied from `origin/main` at `9928fb6f18f87179445892edaf7b7319acd610fc`. That main tree already includes the frontend branch.
- This is a **directory copy plus integration changes**, not a Git merge of all three histories. The original backend branch tip remains the parent of this integration; main is not a merged ancestor.
- Original main checkout, its one-line specification edit, and the pre-existing frontend worktree were preserved. No remote push is performed. The commit containing this document is the integration checkpoint; use `git log -1` for its hash.

## Implemented in this checkpoint

The Vite/React UI is now present alongside the advanced backend. Existing styling/artwork was retained. Backend shared Zod schemas validate incoming responses; adapters translate millicredits to presentation credits and unwrap responses instead of relying on the original UI's incompatible field names.

| Area | Current behavior / source |
| --- | --- |
| Data entry point | `frontend/src/data/index.ts` exports liveApi only. VITE_DATA_MODE cannot select mock fixtures. Runtime mock fallback is removed. |
| Wire adapters | `frontend/src/data/live/adapters.ts` validates accounts, receipts, network, ledger, payouts and RP signatures against `@gpupool/shared`; presentation types remain separate. |
| World login | RP metadata/signature and `new_account` mapped; Selfie credential requested; simulated outcomes removed. Phone/simulator success remains unverified. |
| Registration | `/register-node` resolves to Account and reads node_id, pool_id, gpu, mem_gb, ts and node_sig; shared schema validates submission; login preserves query parameters. |
| Accounts | Actual balance/hold/earnings fields mapped from millicredits; vesting and node-cap fields shown. No synthetic account response. |
| Chat | Real model discovery and SSE response; request ID used for receipt; stream errors/truncation throw. Existing UI token-rate estimate is based on content chunks, not a hardware measurement. |
| Network | Live gateway/Arkiv reads and visible network errors. `/network` now includes `stats` from Arkiv account stats; shared schema defaults stats to [] for older fixtures. |
| Ledger | `{events}` unwrapped into signed event records; limit capped at 100; type filtering is client-side within those recent records, not complete historical pagination. Millicredit summaries converted to credits. |
| Payouts | Real wallet only. Gateway claimable/swept flags gate claims; common V1/V2 claim selector used; UI waits for successful chain receipt before showing locally confirmed claim. Index refresh can lag. |
| Fixture isolation | Mock implementations remain for offline tests but are not imported by application data/wallet/login paths. Built assets checked for seeded wallet/store identifiers. |

### Deliberate limits and follow-up work

- The gateway does not expose entity expiry timestamps. UI labels expiry unavailable rather than manufacturing a fresh 120-second timestamp.
- Payout endpoint lists the address's leaves, not aggregate/open epoch data. Adapter returns no aggregate epoch rows; the current-epoch/aggregate table stays empty. Add a real epoch API and shared schema if those website sections must become populated.
- Account-node layers/throughput are absent in `/me`; detailed live node data is supplied by `/network`. Unknown receipt usage/route values still have presentation defaults; review their display before live acceptance.
- No browser E2E suite or visual acceptance was completed. New automated integration checks exercise the adapter/API layer, not a real browser, World App or wallet.
- Do not describe the current frontend as fully accepted end-to-end. The copied design contains explanatory illustrations and a landing label; audit marketing/illustrative scenes before presentation.
- Advanced functions remain in backend/operator scripts; no new advanced UI was added. Stage replay inside Parallax and Postgres remain unimplemented.

## Verification and reproducibility

Observed results in this worktree:

- Frontend application and Vite-config typechecks passed using `frontend/node_modules/.bin/tsc`.
- Production build passed using Vite from the frontend directory. Existing bundle-size/browser-externalization warnings remain.
- Gateway/shared/Arkiv/agent-client typechecks passed. A pre-existing priority-test fake x402 charge was updated to supply `asset` and `amountRaw`.
- Existing frontend fixture/money suite: **66 checks passed**.
- Shared examples + Arkiv + agent budget suites: **70 tests passed** (`node --test shared/test/examples.test.ts agent-client/test/budget.test.ts arkiv/test/arkiv.test.ts`).
- `frontend/tests/live.test.mts` passed schema/millicredit mapping, malformed response rejection, outage propagation and truncated-stream checks.
- Shell syntax, changed TS syntax, frontend credential-pattern scan and whitespace checks passed.
- Frontend lint reports two existing ParticleScene React warnings; it is not recorded as a clean lint gate.

**Dependency caveat:** two fresh pnpm installs timed out on registry downloads. To validate frontend work, dependencies already installed in the separate frontend worktree were linked locally without modifying that source worktree. Some backend packages were linked from the partial cache. These ignored symlinks are not committed and will not transfer to another checkout. Workspace lockfile was resolved offline. Another agent must run a clean `pnpm install` before release; the copied npm lock is historical, while the root pnpm lock covers the added workspace dependency.

**Blocked checks:** full gateway suite cannot import missing better-sqlite3; Python/Parallax-hook suite needs uncached pycryptodome; Foundry needs solc 0.8.28. These are not passing checks. No live World, Arkiv write, HCS write, x402 transfer, deployment, payout claim or inference launch was performed in this integration.

## Next agent's execution order

1. Confirm branch/worktree and preserve ignored env files. Complete a clean dependency install, rerun typechecks/build/lint and all test suites. Run `pnpm --dir frontend run test:live` for the new API checks.
2. Add browser tests and visually inspect login, signed registration, account, streaming/cancel/failure, directory outage, ledger pending/confirmed, and wallet claim pending/reverted/confirmed states.
3. Obtain **local env-file paths and current host/access details**, not private keys in chat. They were requested but not supplied. The historical `~/agent-bridge-src/agent-bridge/bridge` path is absent on this Mac. Do not assume old venue IPs work.
4. Configure a fresh integration SQLite path with `DB_RESET_ON_MISMATCH=false`; public VITE config only in browser, server/wallet secrets outside it. Use Hedera testnet 296 only.
5. Follow `docs/LIVE-DEMO-RUNBOOK.md` to demonstrate three actual wired nodes, World registration/login, real inference/credit settlement/HCS confirmation, x402 treasury receipt and provider payout. Run the core sequence twice and retain transaction/request evidence.
6. Verify advanced services and operator-script scenarios independently. Report each unavailable feature as blocked. Do not substitute fixtures or infer live success from local tests.

## Historical branch review

The remainder is the earlier remote snapshot, retained as provenance and a source inventory. Its statements about absent frontend and integration gaps describe the remote commits listed there, **not the integration checkpoint above**. Current status above takes precedence for this branch; branch-specific specifications still govern intended behavior.

# Historical remote repository context

Reviewed 2026-11-06. This is a code and branch snapshot for future contributors and agents, not a claim that the complete system has been deployed or tested live. Read `CLAUDE.md` first; the applicable branch's `docs/SPEC.md` controls behavior. This document does not authorize implementing features prohibited by the current checkout's rules.

## 1. Repository and branch snapshot

Remote: https://github.com/agrawalx/Ethglobal-mumbai (the only configured remote, named `origin`). `git ls-remote --heads origin` and a fresh fetch identified all three branches below. No additional remote or submodule configuration was found in the inspected branch trees.

| Remote branch | Reviewed commit | Relationship and purpose |
| --- | --- | --- |
| `main` | `9928fb6f18f87179445892edaf7b7319acd610fc` | Merge of frontend PR #1; contains foundational backend, frontend, node agent, Arkiv package, payout contract, and x402 PoC. |
| `frontend` | `4b53392c8a928529daa702477525898c3afc996a` | Frontend development snapshot. Its complete tracked tree is identical to the reviewed remote `main` tree; `main` adds the merge commit. |
| `backendXoutofscope` | `45cea98d542a3fff936c5b7824074d62a8bdd9b8` | Diverges before the frontend merge; adds Phase 3 backend and substantial post-MVP work. Does **not** contain the frontend application source. |

Common ancestor of `main` and `backendXoutofscope`: `11d46faa7fcbb5b3e8db1d14b1b77760e665de66`. At review, the branches have 2 main-only and 11 backend-only commits. The backend branch is not a complete superset of `main`; simply replacing one with the other loses one side's work.

The user's active local `main` is `18ab3561366e5bd71a3e03d096ea6e66321ba9dd`, older than remote `main`. It has an existing uncommitted one-line deletion in `docs/SPEC.md`. A separate local `frontend` worktree is registered. This review fetched refs and inspected temporary archives; it did not switch, merge, reset, or edit either worktree's existing code. Paths below refer to the specified remote snapshot and may be absent from the active checkout.

## 2. Goal, architecture, and fixed boundaries

A requester outside a wired three-computer pool asks a model that cannot fit on one contributor's computer. Parallax distributes inference across NVIDIA and Apple Silicon nodes. The project adds identity, accounting, discovery, payments, and provider payouts.

- Browser/AI client → Hono TypeScript gateway → private Parallax coordinator API. The gateway is the public entry point; Parallax port 3001 stays on loopback.
- World ID proof → account keyed by a unique World nullifier → starter credits and JWT session. Account/nullifier storage stays in the gateway.
- Session requests use credits; unauthenticated requests use x402 HBAR payments on Hedera testnet.
- SQLite WAL is the operational ledger; signed events are submitted asynchronously to HCS. Arkiv stores expiring public node/pool/model/account-stat listings.
- EpochPayout holds funded Merkle payout roots; providers claim HBAR. The initial contract and newer V2 contract have different interfaces.

Documented hardware evidence in `docs/HANDOFF.md` includes Qwen3-14B split between M4 layers `[0,29)` and RTX 4060 layers `[29,40)`, with approximately 5.2–6 tok/s after smaller Mac KV settings. These are prior recorded results, not measurements reproduced here. A full three-node gateway/World/payout demo is not established by that evidence.

Runtime constraints: pre-download weights; private DHT prefix; telemetry disabled with `-u`; fixed TCP/UDP ports and explicit advertised wired IP; start joins within 30 seconds on the MVP path; stop whole process groups. Mac flags: `--kv-cache-memory-fraction 0.25 --max-sequence-length 4096`. Do not send `logprobs`. Thinking defaults off. Network addresses in examples are historical.

## 3. Main/frontend implementation map

| Component | Entry points / important source | Observed implementation |
| --- | --- | --- |
| Shared interfaces | `shared/src/{api,common,config,hcs,arkiv,merkle,session,canonical}.ts`; JSON examples/config | Zod schemas, inferred TS types, canonical signatures, IDs, route/credit/payout conventions. Workspace packages consume these directly. |
| Gateway | `gateway/src/main.ts`, `app.ts`, `config.ts`, `db.ts` | Node >=24, Hono, better-sqlite3. Loads feature configuration, starts HTTP/HCS/expiry workers. Main schema version 2. |
| Identity | `gateway/src/{world,auth,accounts}.ts` | RP signature through IDKit core; forwards proof to World v4; normalized nullifier uniqueness; one-time starter grant; 24-hour JWT. Existing nullifier logs into the existing account. |
| Credit accounting | `gateway/src/{ledger,billing}.ts` | Conditional holds, atomic settlement, starter-first spending, self-request exclusion, route-based shares, refunds of unused credit holds; failure releases credit hold. |
| Inference | `gateway/src/{chat,route}.ts` | Streaming/non-streaming proxy; request ID, prompt/response hashes, usage capture, transcripts, route from signed node heartbeats/log-derived assignments. |
| Payments | `gateway/src/x402.ts`, `agent-client/src/{agent,budget}.ts` | x402 v2 exact Hedera HBAR; dynamic tier price; settle before inference; client budget and allowed-asset cap. |
| HCS | `gateway/src/{events,hcs,verify-event}.ts` | Ed25519 signatures, unsent SQLite events submitted in order, retry/backoff, sequence numbers added to receipts. |
| Arkiv | `arkiv/src/{client,schema,reader,writer,cli}.ts` | SDK clients, typed queries/encoding, owner-specific upsert, batched patch+expiry extension, model seeding/listing CLI. Reads limited to 100 entities. |
| Node agent | `node-agent/src/gpupool_node/{cli,agent,config,keys,signing,parallax,arkiv}.py` | Python 3.12/uv; persistent EVM identity, registration link, signed 10-second heartbeats; parses node logs for layers; asynchronous Arkiv CLI writes every 30 seconds; coordinator publishes pool state. |
| Pool scripts | `pool/{lib,start-scheduler,join-node,stop-all,status,warmup}.sh` | Wrapper around separately installed Parallax; env loading, launch/process-group handling, status and warm-up. No vendored inference engine. |
| Contract | `contracts/src/EpochPayout.sol`, `script/Deploy.s.sol` | Settler-only funded roots, delayed claims, sorted Merkle proof, double-claim protection, reentrancy guard, delayed sweep. Deployment uses Foundry. |
| Payment PoC | `scripts/x402-poc/src/{server,client,price}.ts` | Separate paid echo example with fake-facilitator tests and recorded testnet evidence. |
| Frontend | `frontend/src/{main,App,ConsoleRoot}.tsx` | Vite/React SPA, history router, lazy console pages; landing, chat, account, network, ledger, payouts. Not Next.js. |

### Main API surface

Implemented in `gateway/src/app.ts`: `GET /healthz`, `POST /v1/chat/completions`, `GET /v1/models`, `POST /auth/world/rp-signature`, `POST /auth/world/verify`, `GET /me`, `POST /nodes/register`, `POST /nodes/heartbeat`, `GET /pools/:pool_id`, `GET /requests/:id`.

Main has **no** `/network`, `/ledger/events`, or `/payouts/:address` handlers and no epoch settlement worker. Its model list queries the configured coordinator's `/v1/models`, filters configured models, and labels results `source: arkiv` as an explicitly temporary implementation. The standalone Arkiv reader exists, but is not the main gateway router yet. Reliability counters exist; full rolling scoring and priority scheduling arrive on the backend branch.

### End-to-end behavior and money conventions

- Credits are integer millicredits (`*_mc`); 1 credit = 1000 mc. Cost is floored from `factor × (output + 0.2 × input) × 1000`. Hold estimates input as `ceil(message characters / 4)` and caps final charge at the hold.
- Nominal split: 90% providers by served layers, 5% burn, remainder reserve (including rounding). Own-node share goes to reserve; unknown route sends provider share to reserve.
- Starter credits default to 10,000, expiring after 14 days. Earned credits do not expire on main. Receipt route uses half-open ranges and must cover all model layers exactly once.
- Main session failure releases hold and charges zero. x402 settles **before** inference, so a later pool failure can remain paid without a successful-payment event or automatic refund. These are different payment failure semantics.
- x402 provider remuneration is HBAR rather than credits. Prices for <=512 / <=2048 output tokens: 8B 0.01 / 0.03 HBAR; 14B 0.02 / 0.06 HBAR.
- HBAR amounts are decimal tinybar strings; 1 HBAR = 100,000,000 tinybars. Contracts see tinybars. Backend JSON-RPC payout code additionally converts transaction value to weibars (`tinybar × 10^10`); do not confuse RPC values with Solidity `msg.value`.
- Merkle leaf: `keccak256(abi.encodePacked(address, uint256 amount))`; sorted pair hashes, sorted leaves, odd node promoted unchanged. Shared contract fixture defines the cross-language vector.
- HCS signs canonical JSON without `sig`, then submits signed canonical JSON. Public events contain hashes, not prompt text. Main stores transcripts for seven days.

### Frontend behavior and integration gaps

Source: `frontend/src/data/{api,index,live/index,mock/index}.ts`, `config/env.ts`, `auth/LoginSheet.tsx`, `pages/Account.tsx`, `shared/types.ts`, and `abis/EpochPayout.ts`.

- Default is `VITE_DATA_MODE=mock`: simulated login, balances, inference, expiring nodes, and claims. Mock state is stored per browser tab. No mock success proves a chain payment or World login.
- Live mode calls the gateway and mirror node. Selected public reads can fall back to mock, with a visible fallback badge. Authenticated/money actions do not silently fall back. Main's missing read APIs therefore leave visible fallback behavior.
- UI has its own TS interface copies under `frontend/src/shared/types.ts`; it does not consume the backend Zod types as the intended shared source of truth. Compare payloads before integration.
- Node agent emits `/register-node?node_id&pool_id&gpu&mem_gb&ts&node_sig`. UI expects `/account?register&gpu&mem&sig`, then posts a different shape. This needs an explicit integration change; the registration demo alone is insufficient evidence.
- Gateway verify returns `new_account`; UI reads `created`, so new-user status is not mapped correctly. Gateway errors and account/receipt/ledger/network/payout payloads also need schema-level integration verification.
- UI IDKit accepts `any(proof_of_human, selfie)` and main gateway accepts Orb/Selfie aliases. Root rules say Selfie only; this is an existing policy/code inconsistency, not permission to alter the policy.
- UI snippets still mention legacy `X-PAYMENT`; gateway/client actually use x402 v2 headers. Wallet targets Hedera testnet 296. Initial ABI matches V1 claim/read methods; V2 epoch reads require an ABI review.

## 4. backendXoutofscope: additional code, not merged MVP

This branch lacks the React/Vite frontend source. It changes the branch-local specification and adds substantial code prohibited by the original root MVP rules. Its final database schema is **12**, despite older reports claiming 9 or 10. Use current source over those historical descriptions.

| Area | Source modules | Added behavior / limits |
| --- | --- | --- |
| Phase 3 routing | `gateway/src/{router,queue,reliability,account-stats}.ts` | Arkiv model/pool discovery; coordinator hash/fresh-heartbeat/layer coverage checks; min-node reliability × (1-load); per-pool slots/ratio priority; scheduled stats publishing. |
| Phase 3 payouts | `gateway/src/{settlement,merkle,payout-chain}.ts` | Epoch closing, frozen payout data, Merkle proofs, signed chain posting/funding, HCS linkage, claim/sweep indexing and payout read API. Requires real testnet configuration to run. |
| Pools/resilience | `gateway/src/{formation,pools,stall}.ts`, enhanced `chat`, `billing`, `route` | Stalls/failover, coordinator maps, auto pool grouping, pool health and restart state, route checks and serving-count disputes. Not equivalent to recovery inside Parallax. |
| Runtime hooks | `pool/hooks/{sitecustomize,gpupool_hooks}.py`, `pool/{restart,pools-up}.sh` | Runtime import patches for heartbeat grace, admission, routing logs, scheduler behavior. Dependency checkout is not edited, but its runtime behavior is changed. These hooks conflict with the original MVP exclusion and depend on upstream internals. |
| Node operations | `node-agent/src/gpupool_node/{notify,system}.py`, updated agent/config | Notifications, restarts, LAN changes, swap checks, probes, served counts and hardware challenges. |
| Privacy | `gateway/src/privacy.ts`, router/chat changes | Trusted-owner routing, optional TLS, encrypted normal transcripts, salted hashes, no transcript for privacy requests. Does not establish cryptographic privacy against inference participants. |
| Output verification | `gateway/src/verification.ts` | Sampling jobs, canaries, hardware challenge, owner-gated appeals and per-node risk. Needs external trusted/calibrated verifier services; protocol tests do not validate model correctness. |
| Incentives | `gateway/src/incentives.ts`, auth/accounts changes | Earned lots/vesting/expiry, verdict-driven penalties/bans, availability rewards, node tiers, collusion flags, account agent keys and routing preferences. |
| Expanded chain features | `EpochPayoutV2.sol`, `gateway/src/{dispute,schedule,swarm,erc8004,legal}.ts` | Challenge/resolve/dismiss V2 payouts, sweep scheduling, optional Bee bundle storage, registration document, configuration/legal gate, optional USDC. Individual optional integrations still require external services and live verification. |

Additional API includes `/network`, `/ledger/events`, `/payouts/:address`, `/pools/plan`, `/agents` (create/list/revoke), `/incentives/flags`, `/verifications/:id`, appeal submission, and `/.well-known/agent-registration.json`. See `gateway/src/app.ts` for authentication and loopback restrictions rather than assuming these are all public.

`gateway/src/main.ts` wires startup workers conditionally: HCS, settlement, account stats, reliability refresh, incentives, verification and canaries. SQLite remains the implemented working database even though `pg` appears in the manifest; a dependency is not proof of a Postgres backend. Reports describe work from different commits and include obsolete “not started” and “nothing pushed” statements. Do not carry those statements forward as current facts.

## 5. Environment and execution context

No private environment contents were used for this document. Example files, configuration schema, and entry points are the configuration authority. A variable's presence in a template does not mean it is consumed by that branch.

- Backend: Node >=24, pnpm workspace; direct TS execution. Shared package exports source and network config. Main versions include x402 2.30.0, IDKit core 4.6.0, Hedera SDK 2.90.1, Arkiv SDK 1.0.1, Hono 4.x, Zod 4.x, better-sqlite3 13.x.
- Frontend: independent Vite 8/React 19 package and npm lock; `npm install`, `npm run dev`, `npm run build`, `npm test`, `npm run lint` from `frontend/`. Default dev port 5173. Vite proxies gateway API paths; deployment needs equivalent API routing. Next.js `NEXT_PUBLIC_*` instructions from earlier setup do not configure this UI.
- Backend from workspace root: `pnpm install`, then `pnpm --filter @gpupool/shared test`, `pnpm --filter @gpupool/gateway test` / `typecheck` / `start`. Gateway package scripts load that component's `.env`.
- Arkiv: `pnpm --filter @gpupool/arkiv cli --help`; inspect CLI commands before any write. Node agent shells out to the TS CLI using the node/pool writer identity.
- Node agent: from `node-agent/`, `uv sync`, `uv run gpupool-node init`, `uv run gpupool-node start --no-join` if Parallax already runs, `uv run pytest -q`. Ordinary `start` launches Parallax. Stop semantics are documented in component README.
- Contract: `forge test --root contracts`; deployment scripts require testnet-only account/config. Do not infer a deployed address from an ABI or fixture.
- Backend branch offers `pnpm --filter @gpupool/gateway verify` and local demo tests/scripts. Some demos and clients perform external actions: inspect before running. `agent-client start` and PoC client spend testnet HBAR.

### Configuration families

| Destination | Values to supply / meaning |
| --- | --- |
| `gateway/.env` | HTTP host/port/public URL/CORS; coordinator URL/timeouts; database path; JWT secret; Ed25519 event-signing seed; World app/RP/server signing key/action/environment; Hedera operator/topic/mirror/RPC; x402 facilitator/network/payee; treasury/settler/payout settings; Arkiv writer/access/RPC. |
| `agent-client/.env` | Gateway URL, testnet payer `AGENT_ACCOUNT_ID` and matching ECDSA `AGENT_PRIVATE_KEY`, spending cap, `HEDERA_NETWORK=testnet`. |
| `arkiv/.env` | RPC/chain/access configuration and wallet identity for CLI writes. |
| `node-agent/.env` | Gateway/frontend URLs; node/pool key paths, pool ID, coordinator flag; heartbeat/expiry intervals; node log; Arkiv config. |
| `pool/node.env` | Installed Parallax path, role/model/node count, private prefix, wired IP/ports, cache/CUDA paths, safe Mac flags. One per host. |
| `contracts/.env` | RPC, deployer key, settler address, claim/sweep delays; V2 adds its own roles and configuration. |
| `frontend/.env.local` | Public `VITE_DATA_MODE`, `VITE_GATEWAY_URL`, `VITE_WORLD_APP_ID`, `VITE_WORLD_ACTION`, `VITE_HEDERA_RPC`, `VITE_PAYOUT_ADDR`, `VITE_HCS_TOPIC`, `VITE_MIRROR_URL`. Never private keys. |

x402 is implemented in the reviewed remote code, contrary to earlier conversation based on the old checkout. No separate `X402_KEY` exists. Main uses `X402_NETWORK=hedera:testnet`, `X402_PAY_TO=<treasury 0.0.x account>`, and a facilitator URL. `scripts/x402-poc/README.md` records native-HBAR payments through `https://x402.org/facilitator`, no facilitator API key, and alternative testnet services. These are repository-recorded live findings; current service availability was not retested here. Check `/supported` before a new payment test. Headers are `PAYMENT-REQUIRED`, `PAYMENT-SIGNATURE`, and `PAYMENT-RESPONSE`. EVM aliases are rejected for payee IDs by the code.

## 6. External repositories and evidence boundaries

- [GradientHQ/parallax](https://github.com/GradientHQ/parallax): external inference engine, not another application remote or submodule. Repository records tested commit `162354a`, Lattica 1.0.21 and SGLang 0.5.12. External repository landing/source layout was checked; all its branches and installed host checkouts were not audited. Local wrappers/log parsers and backend runtime hooks define this application's integration.
- [x402-foundation/x402](https://github.com/x402-foundation/x402): upstream protocol/SDK referenced explicitly in PoC documentation. This project pins v2 packages to 2.30.0; do not substitute the older Hedera v1 example implementation from earlier conversation.
- [ELLA0VICTOR/quil](https://github.com/ELLA0VICTOR/quil): frontend visual source credited in `frontend/NOTICE.md`, with local MIT license. External page could not be fetched during this review; attribution is based on repository files.
- [vihaan1016/omniverse](https://github.com/vihaan1016/omniverse): credited scroll-story source, not a runtime prediction-market dependency. External repository page checked; its unrelated application branches were not audited.
- [ggml-org/llama.cpp](https://github.com/ggml-org/llama.cpp) and the Darkbloom repository link appear in historical research notes, not as the chosen production inference backend. Research notes are background, not requirements.

“All branches” in this document means every advertised branch of the linked `agrawalx/Ethglobal-mumbai` origin at the review time. Third-party repository coverage is focused on their project role, not an exhaustive audit of their complete histories or branches.

## 7. Verification performed and remaining checks

Performed on isolated archives of the exact commits above:

- Fresh `git fetch origin`; branch enumeration and commit relationships checked using `git ls-remote`, `git merge-base`, and `git rev-list`.
- `git diff --quiet origin/main origin/frontend` succeeded: identical tracked trees.
- All tracked shell scripts in all three snapshots passed `bash -n`.
- `forge test --root <snapshot>/contracts --offline` attempted for main and backend: both blocked because solc 0.8.28 is not installed. No Solidity pass is claimed.
- Backend hook test import attempted with `python3 -m unittest discover -s pool/hooks -p 'test_*.py'`: blocked by missing `pytest`. Intended runner is pytest; hook tests did not run.
- TypeScript/Python dependency-backed suites, frontend rendering/build, live World login, live HCS/Arkiv/facilitator calls, contract deployments and multi-machine inference were not run. Their existing test files and documented evidence were inspected; historical test counts are not new verification.

Before claiming an integrated demo: reconcile frontend/backend payloads and registration route; pick the intended branch/features under applicable rules; run its dependency-backed suites; validate World login and repeat login; exercise streaming usage accounting with real Parallax; verify Arkiv routing and expiry; obtain a settled x402 tx; close an epoch and claim from a real provider wallet. No merge or implementation decision is implied by this review.

## 8. Reading order for the next session

1. `CLAUDE.md`, branch-specific `docs/SPEC.md`, then this branch snapshot table.
2. `docs/HANDOFF.md` for recorded hardware and integration evidence; verify claims against current source.
3. `shared/README.md` and shared schemas/config for units and wire contracts.
4. Relevant component README, its manifest and entry point, then implementation and tests.
5. For backend-only work: `gateway/src/main.ts`, `app.ts`, `db.ts`, then `docs/POST_MVP_PLAN.md` and reports as historical context. Do not assume section reports match the tip.

To refresh this document, enumerate remote heads again and compare against the recorded hashes. Preserve dirty work and existing worktrees; use `git show <ref>:<path>` or archives to inspect other branches. Never copy real keys into a context handoff.

## 9. Source inventory for follow-up

This inventory covers application source, tests, and shell scripts, excluding generated artifacts and binary assets. Main and frontend share one inventory because their trees match. The backend list records additions and modifications against main; frontend removals are summarized above.

### Main/frontend

**shared**

- `shared/src/api.ts`
- `shared/src/arkiv.ts`
- `shared/src/canonical.ts`
- `shared/src/common.ts`
- `shared/src/config.ts`
- `shared/src/hcs.ts`
- `shared/src/index.ts`
- `shared/src/merkle.ts`
- `shared/src/session.ts`
- `shared/test/examples.test.ts`

**gateway**

- `gateway/scripts/dev-session.ts`
- `gateway/src/accounts.ts`
- `gateway/src/app.ts`
- `gateway/src/auth.ts`
- `gateway/src/billing.ts`
- `gateway/src/chat.ts`
- `gateway/src/config.ts`
- `gateway/src/db.ts`
- `gateway/src/errors.ts`
- `gateway/src/events.ts`
- `gateway/src/hcs.ts`
- `gateway/src/ledger.ts`
- `gateway/src/main.ts`
- `gateway/src/nodes.ts`
- `gateway/src/route.ts`
- `gateway/src/verify-event.ts`
- `gateway/src/world.ts`
- `gateway/src/x402.ts`
- `gateway/test/cross-language.test.ts`
- `gateway/test/fake-parallax.ts`
- `gateway/test/gateway.test.ts`
- `gateway/test/hcs.test.ts`
- `gateway/test/helpers.ts`
- `gateway/test/ledger.test.ts`
- `gateway/test/nodes.test.ts`
- `gateway/test/world.test.ts`
- `gateway/test/x402.test.ts`

**arkiv**

- `arkiv/src/cli.ts`
- `arkiv/src/client.ts`
- `arkiv/src/index.ts`
- `arkiv/src/reader.ts`
- `arkiv/src/schema.ts`
- `arkiv/src/writer.ts`
- `arkiv/test/arkiv.test.ts`

**agent-client**

- `agent-client/src/agent.ts`
- `agent-client/src/budget.ts`
- `agent-client/test/budget.test.ts`

**contracts**

- `contracts/script/Deploy.s.sol`
- `contracts/src/EpochPayout.sol`
- `contracts/test/EpochPayout.t.sol`

**node-agent**

- `node-agent/src/gpupool_node/__init__.py`
- `node-agent/src/gpupool_node/agent.py`
- `node-agent/src/gpupool_node/arkiv.py`
- `node-agent/src/gpupool_node/cli.py`
- `node-agent/src/gpupool_node/config.py`
- `node-agent/src/gpupool_node/keys.py`
- `node-agent/src/gpupool_node/parallax.py`
- `node-agent/src/gpupool_node/signing.py`
- `node-agent/tests/make_vector.py`
- `node-agent/tests/test_node_agent.py`

**pool**

- `pool/join-node.sh`
- `pool/lib.sh`
- `pool/start-scheduler.sh`
- `pool/status.sh`
- `pool/stop-all.sh`
- `pool/warmup.sh`

**scripts**

- `scripts/x402-poc/src/client.ts`
- `scripts/x402-poc/src/price.ts`
- `scripts/x402-poc/src/server.ts`
- `scripts/x402-poc/test/poc.test.ts`

**frontend**

- `frontend/src/App.tsx`
- `frontend/src/ConsoleRoot.tsx`
- `frontend/src/abis/EpochPayout.ts`
- `frontend/src/auth/LoginSheet.tsx`
- `frontend/src/auth/Session.tsx`
- `frontend/src/auth/context.ts`
- `frontend/src/components/AgentSprite.tsx`
- `frontend/src/components/ConsoleShell.tsx`
- `frontend/src/components/CrewScene.tsx`
- `frontend/src/components/Icon.tsx`
- `frontend/src/components/ParticleScene.tsx`
- `frontend/src/components/ParticleStage.tsx`
- `frontend/src/components/Shared.tsx`
- `frontend/src/components/SourceBadge.tsx`
- `frontend/src/components/chat/InferenceTile.tsx`
- `frontend/src/components/chat/ReceiptSheet.tsx`
- `frontend/src/components/chat/RouteTrace.tsx`
- `frontend/src/components/chat/TokMeter.tsx`
- `frontend/src/components/console/CopyButton.tsx`
- `frontend/src/components/console/Status.tsx`
- `frontend/src/components/network/ExpiryRing.tsx`
- `frontend/src/components/network/NodeCard.tsx`
- `frontend/src/components/network/PipelineDiagram.tsx`
- `frontend/src/components/story/PoolStory.tsx`
- `frontend/src/components/story/stage.ts`
- `frontend/src/config/brand.ts`
- `frontend/src/config/env.ts`
- `frontend/src/data/api.ts`
- `frontend/src/data/crew.ts`
- `frontend/src/data/index.ts`
- `frontend/src/data/live/index.ts`
- `frontend/src/data/mock/fixtures.ts`
- `frontend/src/data/mock/index.ts`
- `frontend/src/hooks/useAsync.ts`
- `frontend/src/hooks/usePool.ts`
- `frontend/src/lib/credits.ts`
- `frontend/src/lib/format.ts`
- `frontend/src/lib/links.ts`
- `frontend/src/lib/nodeColor.ts`
- `frontend/src/lib/router.ts`
- `frontend/src/main.tsx`
- `frontend/src/pages/Account.tsx`
- `frontend/src/pages/Chat.tsx`
- `frontend/src/pages/Landing.tsx`
- `frontend/src/pages/Ledger.tsx`
- `frontend/src/pages/Network.tsx`
- `frontend/src/pages/NotFound.tsx`
- `frontend/src/pages/Payouts.tsx`
- `frontend/src/shared/types.ts`
- `frontend/src/wallet/Providers.tsx`
- `frontend/src/wallet/WalletButton.tsx`
- `frontend/src/wallet/config.ts`
- `frontend/src/wallet/demo.ts`
- `frontend/src/wallet/useWallet.ts`
- `frontend/tests/data.test.mts`
- `frontend/vite.config.ts`

### Backend additions and modifications

- Modified `agent-client/src/agent.ts`
- Modified `arkiv/src/cli.ts`
- Modified `arkiv/src/reader.ts`
- Added `contracts/script/DeployV2.s.sol`
- Added `contracts/src/EpochPayoutV2.sol`
- Added `contracts/test/EpochPayoutV2.t.sol`
- Added `gateway/scripts/agent-feedback.ts`
- Added `gateway/scripts/associate-usdc.ts`
- Added `gateway/scripts/claim-payout.ts`
- Added `gateway/scripts/dispute.ts`
- Added `gateway/scripts/incentives-demo.ts`
- Added `gateway/scripts/privacy-demo.ts`
- Added `gateway/scripts/register-agent.ts`
- Added `gateway/scripts/verify-backend.ts`
- Added `gateway/scripts/verify-bundle.ts`
- Added `gateway/src/account-stats.ts`
- Modified `gateway/src/accounts.ts`
- Modified `gateway/src/app.ts`
- Modified `gateway/src/auth.ts`
- Modified `gateway/src/billing.ts`
- Modified `gateway/src/chat.ts`
- Modified `gateway/src/config.ts`
- Modified `gateway/src/db.ts`
- Added `gateway/src/dispute.ts`
- Added `gateway/src/erc8004.ts`
- Added `gateway/src/formation.ts`
- Added `gateway/src/incentives.ts`
- Modified `gateway/src/ledger.ts`
- Added `gateway/src/legal.ts`
- Modified `gateway/src/main.ts`
- Added `gateway/src/merkle.ts`
- Modified `gateway/src/nodes.ts`
- Added `gateway/src/payout-chain.ts`
- Added `gateway/src/pools.ts`
- Added `gateway/src/privacy.ts`
- Added `gateway/src/queue.ts`
- Added `gateway/src/reliability.ts`
- Modified `gateway/src/route.ts`
- Added `gateway/src/router.ts`
- Added `gateway/src/schedule.ts`
- Added `gateway/src/settlement.ts`
- Added `gateway/src/stall.ts`
- Added `gateway/src/swarm.ts`
- Added `gateway/src/verification.ts`
- Modified `gateway/src/world.ts`
- Modified `gateway/src/x402.ts`
- Added `gateway/test/account-stats.test.ts`
- Added `gateway/test/backend-demo.test.ts`
- Added `gateway/test/db-reset.test.ts`
- Added `gateway/test/failover.test.ts`
- Added `gateway/test/fake-settlement.ts`
- Modified `gateway/test/gateway.test.ts`
- Modified `gateway/test/helpers.ts`
- Added `gateway/test/incentives.test.ts`
- Modified `gateway/test/ledger.test.ts`
- Added `gateway/test/network-ledger.test.ts`
- Modified `gateway/test/nodes.test.ts`
- Added `gateway/test/p5.test.ts`
- Added `gateway/test/payout-chain.test.ts`
- Added `gateway/test/priority.test.ts`
- Added `gateway/test/privacy.test.ts`
- Added `gateway/test/queue.test.ts`
- Added `gateway/test/reliability.test.ts`
- Added `gateway/test/router.test.ts`
- Added `gateway/test/s16.test.ts`
- Added `gateway/test/settlement-v2.test.ts`
- Added `gateway/test/settlement.test.ts`
- Added `gateway/test/verification.test.ts`
- Modified `gateway/test/world.test.ts`
- Modified `gateway/test/x402.test.ts`
- Modified `node-agent/src/gpupool_node/agent.py`
- Modified `node-agent/src/gpupool_node/config.py`
- Added `node-agent/src/gpupool_node/notify.py`
- Modified `node-agent/src/gpupool_node/parallax.py`
- Modified `node-agent/src/gpupool_node/signing.py`
- Added `node-agent/src/gpupool_node/system.py`
- Modified `node-agent/tests/test_node_agent.py`
- Added `node-agent/tests/test_p5.py`
- Added `pool/hooks/gpupool_hooks.py`
- Added `pool/hooks/sitecustomize.py`
- Added `pool/hooks/test_hooks.py`
- Modified `pool/join-node.sh`
- Modified `pool/lib.sh`
- Added `pool/pools-up.sh`
- Added `pool/restart.sh`
- Modified `pool/start-scheduler.sh`
- Added `shared/src/agent-registration.ts`
- Modified `shared/src/api.ts`
- Modified `shared/src/config.ts`
- Modified `shared/src/hcs.ts`
- Modified `shared/src/index.ts`
- Modified `shared/src/merkle.ts`
- Modified `shared/test/examples.test.ts`
