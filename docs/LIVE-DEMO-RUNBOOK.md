# Live integration runbook

Branch: backendXoutofscope. Main's frontend was copied, not merged; source backend remains this branch. Worktree: `/private/tmp/gpupool-backend-live`. Original worktrees and databases remain untouched. No push is authorized.

## Start and configuration

Install from workspace root with `pnpm install`. Frontend: `pnpm --dir frontend dev`; build with `pnpm --dir frontend build`. Gateway: `pnpm --filter @gpupool/gateway start`. Copy component env examples only when the destination does not exist. Actual secrets stay in ignored files; never in VITE variables.

Frontend always uses liveApi, regardless of VITE_DATA_MODE. Configure VITE_GATEWAY_URL (gateway or empty for same-origin proxy), VITE_HCS_TOPIC and VITE_PAYOUT_ADDR. The RP response supplies World app/action/environment. Serve through trusted HTTPS for phone login; route API requests to the gateway. Gateway CORS must allow the frontend origin. Do not expose Parallax HTTP APIs publicly.

Use DATABASE_PATH=./data/live-integration.sqlite and DB_RESET_ON_MISMATCH=false in gateway/.env. Configure World/JWT/event signer, HCS operator/topic, Arkiv access/writer, x402 payee/facilitator/network, treasury/settler and contract. Set PAYOUT_CONTRACT_VERSION=2 for advanced demos and configure V2 roles. Use testnet only, chain 296. A successful HTTP health check is not proof of configured features.

## Ownership checklist

- Frontend: response mappings/shared-schema validation, correct signed registration links, real login, balance/receipts/ledger/network/payout views, real wallet confirmation. No mock fallback. Verify UI visually and with browser tests before claiming acceptance.
- Backend: streaming usage/settlement, HCS retries, Arkiv routing/stats, payout proofs/claim indexing, advanced workers. Verify actual API responses using shared schemas. The network API now exposes Arkiv account stats; expiry timestamps remain unavailable and are labeled accordingly. Payout API lists this address's leaves, not aggregate epoch totals; the frontend does not invent totals.
- Operator: current Ethernet IPs, cached weights, matching Parallax revision, keys/owner identities, funded accounts, deployed V2 address, browser-trusted URL, verifier URLs/owners, Bee postage, registry addresses and additional pool capacity. These values have not been discovered or provisioned by this integration.

## Core live acceptance (run twice)

1. Inventory coordinator/Linux GPU/M4/M5 addresses, identities, cached model, installed revision, fixed ports and safe Mac flags. Validate hook compatibility with the installed Parallax source. Restrict peer firewall rules to pool hosts.
2. Start scheduler and three node joins together, then agents. Use current component README commands; agent bridge location in historical handoff is missing on this Mac. Remote coordination needs the actual bridge/access setup.
3. Each owner opens the real `/register-node?...` link, completes World Selfie verification, connects their testnet wallet and confirms registration. Repeat login must grant zero new starter credits.
4. Verify fresh signed heartbeats and Arkiv listings, exact model layer coverage and real model discovery. Request from the separate requester laptop; record request ID and nodes/layers. Confirm streamed usage, accurate credit deduction and receipt.
5. Wait for HCS confirmation; compare the signed payload with the mirror node. Pending is not success.
6. Inspect facilitator `/supported` for hedera:testnet HBAR support. Run existing agent client with an explicit testnet budget, record payment tx and actual treasury receipt.
7. Close a funded epoch; wait for challenge/vesting windows, claim from the provider's real wallet and confirm tx status and indexed claim. Repeat claim must fail. Verify tinybar/weibar handling.
8. Interrupt a service/node in a controlled test and verify honest unavailable/stale state. Preserve evidence and restore the pool.

Record each run's timestamp, request ID, layer map, HCS seq, payment/post/claim txs, contract address and pass/fail in a separate evidence file. No private keys or proof payloads.

## Advanced acceptance (operator scripts)

Run actual alternate-pool failover, restart/admission/election/expiry, privacy routing, primary+appeal verifier checks with independent owners and calibration, hardware challenges, incentive transitions, USDC association/payment, V2 dispute resolution, scheduled sweep, Bee upload/retrieval/root verification, and registry transactions. Existing CLI scripts live under gateway/scripts. Inspect each before execution and use explicit testnet budgets. Do not claim absent stage replay or Postgres. Missing services or access are blockers, not reasons to substitute fixtures.

## Validation

Run shared/gateway/Arkiv/agent-client tests and typechecks, frontend build/lint/test/test:live, node-agent pytest, hook pytest, shell syntax checks, and forge tests for both contracts. Browser fixtures are automated tests, never live evidence. Complete browser visual and wallet/World checks separately. Do not declare end-to-end completion until the core passes twice and advanced checklist results are recorded.

## This integration's verification record (2026-11-06)

Passed: frontend app and Vite-config typechecks; Vite production build; gateway/shared/Arkiv/agent-client typechecks; 66 existing frontend fixture/money checks; 70 shared/Arkiv/agent-budget tests; new live schema/unit mapping, outage and truncated-stream tests; shell syntax and changed TS syntax checks. Production assets contain neither the seeded mock store nor seeded demo wallet identifiers. A stale priority-test x402 result was updated with asset/amountRaw to match the current interface.

A clean `pnpm install` from the workspace root works (checked 2026-11-06); the frontend uses the root pnpm lockfile.

Gateway suite remains blocked by missing better-sqlite3, even with local sockets permitted. Python suite is blocked by an uncached pycryptodome wheel. Foundry is blocked by missing solc 0.8.28. Lint reports two pre-existing ParticleScene React warnings. Browser E2E/visual tests and live World, Ethernet pool, chain claims and advanced-service acceptance are not completed. The operator must supply current environment-file locations and machine access. No real payment, deployment, inference launch, push or database reset was performed.

## Live 3-node run record (2026-11-06, evening)

Pool: M4 `[0,14)` → M5 `[14,29)` → RTX 4060 `[29,40)`, Qwen3-14B, launched over SSH as in `docs/MAC-SSH-TESTING.md`. Gateway `:8080`, Vite `:5173`, testnet only.

| Component | Result | Evidence |
|---|---|---|
| 3-node pool | PASS | 5/5 bench runs, median decode 7.92 tok/s, TTFT 0.43 s |
| World ID login (staging simulator) | PASS | new account + 10,000 starter (HCS #8, #9); repeat login = same account, no grant; cancel = no account. Widget must request `any(proof_of_human, selfie)`; simulator "Human" = proof_of_human |
| Node agents (Linux + 2 Macs) | PASS | layers read from Parallax logs; signed heartbeats; Arkiv node listings; pool listing `ready` with exact layer map; `/v1/models` from Arkiv |
| Node registration | PASS | signed `init` links → `POST /nodes/register` for 3 owner accounts with provider payout addresses |
| Credit chat (browser) | PASS | `req_mw50mfg49ae357208d0d179b`: cost 900,550 mc; split 283,673 / 303,935 / 222,886, burn 45,027, reserve 45,029 (exact); owners' credits vest; HCS #19 schema + signature valid |
| x402 agent | PASS | 3 × 2,000,000 tinybar agent → treasury, SUCCESS; HCS #20–22 |
| Priority queue | PASS | ratio 12.96 request queued later was served before a ratio-0 request |
| Self-request rule | PASS | owner's own node share 0 → reserve |
| Availability rewards (§16.3) | PASS | `availability_reward` events while the pool had a queue |
| Epoch settlement + claim | PASS | epoch 2989953: 4,800,000 tinybar (80% of 6,000,000) → 1,680,000 / 1,800,000 / 1,320,000 by layers; claim tx `0x9a3581ef…` moved 1,320,000 tinybar; repeat claim reverts; `payout_claimed` HCS #32 |
| Hooks live (§16.1) | PASS | `gpupool hooks: patched …` on scheduler and nodes; ghost guard rejected a stale peer; route log maps request → routing table |
| Node killed mid-answer | PASS | stall event `pool_error` 5 s after the kill; request `failed`; charge 0 |
| Node rejoin | PASS with hooks | cool-down hook avoided a global rebalance; other nodes kept weights; served again 139 s after rejoin. Without hooks the rejoin failed (scheduler exception, node gave up after 5 min) |

Fixed during the run: World widget credential (`any(proof_of_human, selfie)`); swap watch only on unified-memory (Mac) nodes (a swapping CUDA host blocked the pool silently); router logs why it skips a pool; elected pool writer signs the pool listing with its node key when it has no pool key.

Open findings:
- The staging simulator returned the same nullifier for every test identity; multiple World accounts from one browser are not possible. Owner accounts were made with `gateway/scripts/dev-session.ts`.
- The UI payout address needs a browser wallet; none in the test browser (registration done through the API).
- Settle is capped at the hold; the chars/4 input estimate undercharged one request by 3.15 credits.
- Claim gas (~0.107 HBAR) exceeded the demo payout (0.0132 HBAR); batch claims or larger epochs are needed.
- Stage blame fell back to the whole route: the 5 s stall check fires before a heartbeat is 20 s late.
- Node agents do not report tok/s.
- Hashio JSON-RPC returned intermittent 502s and timeouts; settlement retried until it posted.
- Use the hooks-on launch (`GPUPOOL_HOOKS=1`, `PYTHONPATH=pool/hooks`, cool-down 60 s, route log) for the demo.
