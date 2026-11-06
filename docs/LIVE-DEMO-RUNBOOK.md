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

Fresh pnpm installation failed twice on registry timeouts (better-sqlite3 and platform compiler downloads). Frontend validation reused dependencies already installed in the existing frontend worktree without modifying that worktree. Re-run from a clean install before release. The workspace lockfile was resolved offline.

Gateway suite remains blocked by missing better-sqlite3, even with local sockets permitted. Python suite is blocked by an uncached pycryptodome wheel. Foundry is blocked by missing solc 0.8.28. Lint reports two pre-existing ParticleScene React warnings. Browser E2E/visual tests and live World, Ethernet pool, chain claims and advanced-service acceptance are not completed. The operator must supply current environment-file locations and machine access. No real payment, deployment, inference launch, push or database reset was performed.
