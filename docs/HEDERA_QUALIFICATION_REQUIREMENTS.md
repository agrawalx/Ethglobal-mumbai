# Hedera track: qualification status

**Track:** 🤖 AI Agents That Pay: x402 on Hedera ($6,500: $3,000 / $2,000 / $1,500), ETHGlobal Mumbai 2026
**Project:** GPU Pool, an OpenAI-compatible AI inference API served by a pool of laptops (Qwen3-14B across M4 → M5 → RTX 4060). AI agents pay per request with x402 on Hedera testnet; laptop owners are paid in HBAR per epoch and in credits.
**Status date:** 2026-11-07. Evidence is from Hedera testnet and was re-checked on the public mirror node.

---

## Summary

| # | Requirement | Status |
|---|---|---|
| M1 | x402-protected endpoint settling on Hedera via a listed facilitator | Done |
| M2 | Agent finds the endpoint and completes a paid request with no human | Done: AI agent paid 2 chat requests on its own (txs below) |
| M3 | Public GitHub repo; README with setup, architecture, payment flow, settled tx ID | Repo is public; payment flow and tx IDs are in this file (README section pending) |
| M4 | Demo video ≤ 5 min showing a payment settling, with a HashScan link | Recorded: [Hedera x402 Payment](https://www.youtube.com/watch?v=zQ4D1H8n550) |
| E1 | Spending controls for agents | Built: total budget, per-payment cap, asset allowlist, API-key cap |
| E2 | Agent identity / reputation (ERC-8004) | Built: registration document served; registration and feedback scripts |
| E3 | HCS topic as a tamper-evident audit log of agent spending | Done and proven |
| E5 | HTS token settlement (USDC) and revenue split | Built: USDC accepted beside HBAR; provider revenue split by layers |

**To qualify, still required:** add the payment-flow section and a settled tx ID to the README (M3).

---

## Payment flow (x402 on Hedera)

1. The agent calls `POST /v1/chat/completions` with no session.
2. The gateway answers **HTTP 402**. `PAYMENT-REQUIRED` carries the quote: scheme `exact`, network `hedera:testnet`, asset `0.0.0` (HBAR, tinybars), the price for the model and `max_tokens` tier, `payTo` = treasury `0.0.11331600`, `extra.feePayer` = facilitator `0.0.9185802`.
3. The agent signs a Hedera transfer (`@x402/hedera`) and resends the request with `PAYMENT-SIGNATURE`. No human approves.
4. The facilitator (`https://x402.org/facilitator`) verifies and settles the transfer on Hedera and **pays the network fee**. Settlement happens before inference, so the answer can stream.
5. The answer streams back with `PAYMENT-RESPONSE` (the Hedera transaction ID). The gateway writes a signed `x402_payment` event to HCS topic `0.0.11332608` with the payer, tx ID, amount and the route of laptops.
6. Each epoch (600 s), 80% of x402 income goes to the laptop owners by layers served (10% reserve, 10% operations) through the `EpochPayout` contract; owners claim HBAR to their wallets.

Prices (HBAR per request): Qwen3-8B 0.01 (≤ 512 tokens) / 0.03 (≤ 2048); Qwen3-14B 0.02 / 0.06.

### Live run (2026-11-07, public gateway `https://ethglobal.yash-agrawal.dev`)

```text
$ curl -i https://ethglobal.yash-agrawal.dev/v1/chat/completions      # no payment
HTTP/2 402
x402 accepts: {"scheme":"exact","network":"hedera:testnet","amount":"1000000","asset":"0.0.0","payTo":"0.0.11331600"} feePayer: 0.0.9185802

$ pnpm start --questions 2 --model Qwen/Qwen3-8B-FP8                   # AI agent, budget 0.02 HBAR
Q: In one sentence: what is pipeline parallelism in LLM inference?
paid 1000000 base units of hbar (1000000 tinybar equivalent), tx 0.0.9185802@1794018731.489265813
receipt: https://ethglobal.yash-agrawal.dev/requests/req_mw5sfn2td9071a12c643c240
Q: Name two benefits of splitting a model across several consumer GPUs.
paid 1000000 base units of hbar (1000000 tinybar equivalent), tx 0.0.9185802@1794018738.510280927
receipt: https://ethglobal.yash-agrawal.dev/requests/req_mw5sft2m3e7d71c3463d3f42
spent 2000000 tinybar (0.02 HBAR) of budget 0.02 HBAR
```

### Settled transactions (verified on the Hedera mirror node)

| What | Transaction ID | HashScan | Result |
|---|---|---|---|
| AI agent pays for question 1 (Qwen3-8B) | `0.0.9185802@1794018731.489265813` | https://hashscan.io/testnet/transaction/0.0.9185802-1794018731-489265813 | **SUCCESS**, agent `0.0.11332604` −1,000,000 → treasury `0.0.11331600` +1,000,000 tinybar; fee 295,141 paid by facilitator; consensus `1794018736.025971426`; receipt `req_mw5sfn2td9071a12c643c240` |
| AI agent pays for question 2 (Qwen3-8B) | `0.0.9185802@1794018738.510280927` | https://hashscan.io/testnet/transaction/0.0.9185802-1794018738-510280927 | **SUCCESS**, agent −1,000,000 → treasury +1,000,000 tinybar; fee 295,141 paid by facilitator; consensus `1794018743.997124503`; receipt `req_mw5sft2m3e7d71c3463d3f42` |
| Agent buys API-key credits | `0.0.9185802@1794011853.698529921` | https://hashscan.io/testnet/transaction/0.0.9185802-1794011853-698529921 | **SUCCESS**, agent −100,000,000 → treasury +100,000,000 tinybar (1 HBAR); fee 296,290 paid by facilitator; `credits_purchased` HCS #104, signature valid |
| Proof of concept payment | `0.0.9185802@1793929496.997341480` | https://hashscan.io/testnet/transaction/0.0.9185802-1793929496-997341480 | **SUCCESS**, 0.02 HBAR agent → treasury |

Transaction IDs start with `0.0.9185802` because the facilitator submits each transfer and pays its fee; the payer is the agent.

| Role | Hedera testnet address |
|---|---|
| Agent (payer) | `0.0.11332604` |
| Treasury (`payTo`) | `0.0.11331600` |
| Facilitator fee payer (x402.org) | `0.0.9185802` |
| HCS audit topic | `0.0.11332608` |
| Gateway signing public key | `0x9750f108f4273406aa7498086fc73b404633e5750d9f1d3dacfd95c1cc58c508` |
| EpochPayout contract | `0x22aafc9cbdafd4e5a7e7eae47b27cad48ad8b82c` |
| Public gateway | `https://ethglobal.yash-agrawal.dev` |

---

## Mandatory requirements

### M1. An x402-protected endpoint that settles on Hedera through a listed facilitator

**What exists**
- Two x402-protected endpoints in the gateway:
  - `POST /v1/chat/completions`: a request **without a session** gets HTTP 402. The price depends on model × `max_tokens` tier (Qwen3-14B: 0.02 HBAR up to 512 tokens, 0.06 HBAR up to 2048).
  - `POST /v1/credits/topup`: an API key buys credits with HBAR (1 HBAR = 10 credits, 1–1000 HBAR).
- Protocol: x402 **v2**, `exact` scheme, network `hedera:testnet`, native HBAR (`asset "0.0.0"`, tinybars) and USDC (`0.0.429274`).
- Headers: `PAYMENT-REQUIRED` (402 quote), `PAYMENT-SIGNATURE` (signed payment), `PAYMENT-RESPONSE` (settlement).
- Facilitator: **Official x402**, `https://x402.org/facilitator` (fee payer `0.0.9185802`), which is listed in the Hedera docs. Its `/supported` endpoint lists `hedera:testnet`.
- Settlement happens **before** inference, so the answer can stream.
- Treasury (`payTo`): `0.0.11331600`. Only a `0.0.x` account ID is accepted, not an EVM alias.

**Code:** `gateway/src/x402.ts`, `gateway/src/billing.ts`, `gateway/src/app.ts` (`/v1/credits/topup`). Packages: `@x402/core` and `@x402/hedera` 2.30.0.

**Evidence**
| Item | Value |
|---|---|
| Settled top-up (2026-11-07) | `0.0.9185802@1794011853.698529921`: agent `0.0.11332604` −100,000,000 tinybar → treasury `0.0.11331600` +100,000,000; **SUCCESS**, CRYPTOTRANSFER; network fee 296,290 tinybar paid by the facilitator `0.0.9185802` |
| HashScan | https://hashscan.io/testnet/transaction/0.0.9185802-1794011853-698529921 |
| Agent chat payments (2026-11-07) | `0.0.9185802@1794018731.489265813` and `0.0.9185802@1794018738.510280927`, 0.01 HBAR each, SUCCESS (see "Settled transactions") |
| Earlier settled payment (PoC, 2026-11-06) | `0.0.9185802@1793929496.997341480`: agent → treasury 0.02 HBAR, SUCCESS. https://hashscan.io/testnet/transaction/0.0.9185802-1793929496-997341480 |

**402 challenge captured** on the public gateway: `HTTP/2 402` with `scheme exact`, `hedera:testnet`, `amount 1000000`, `asset 0.0.0`, `payTo 0.0.11331600`, `feePayer 0.0.9185802` (see "Live run" above).

---

### M2. An agent or client finds the endpoint and completes a paid request with no human approving

**What exists**
- `agent-client/src/agent.ts`: an AI agent that asks questions without a session. It receives the 402, **signs the HBAR transfer itself** (`@x402/hedera` client signer), retries and gets the answer. No human approves anything. It prints a HashScan link per payment.
- `agent-client/src/topup.ts`: a client that buys API-key credits through x402, also with no human approving.
- The agent finds what it can buy through `GET /v1/models`, which lists only models with a ready pool (pools come from the Arkiv directory).

**Evidence**
| Item | Value |
|---|---|
| Top-up client paid with no human (2026-11-07) | tx above; key `agt_23d1bf91720ef792` credits 0 → 10 |
| **AI agent paid 2 chat requests, no human (2026-11-07)** | `0.0.9185802@1794018731.489265813` (`req_mw5sfn2td9071a12c643c240`) and `0.0.9185802@1794018738.510280927` (`req_mw5sft2m3e7d71c3463d3f42`), 0.01 HBAR each, SUCCESS |
| Agent chat payments (earlier live demo run) | 3 × 2,000,000 tinybar agent → treasury, SUCCESS; audit events HCS #20–22 (`docs/LIVE-DEMO-RUNBOOK.md`) |



---

### M3. Public GitHub repo with a README covering setup, architecture and the payment flow, with a settled Hedera tx ID

**What exists**
- Repo: `https://github.com/agrawalx/Ethglobal-mumbai`.
- `README.md` has the project summary, an architecture diagram (including `x402 · Hedera`), setup notes and the credit / x402 revenue split (90/5/5 credits; 80% of x402 HBAR to providers by epoch Merkle claims).
- Detailed x402 notes and a settled tx: `scripts/x402-poc/README.md`.

- **The repo is public** (checked 2026-11-07, HTTP 200).
- The payment flow and settled tx IDs are documented in this file (sections above).

**What is not there**
- **The README itself has no x402 payment-flow section and no Hedera tx ID.** The track asks for them in the README. To add:
   - the step-by-step flow: request → 402 + `PAYMENT-REQUIRED` → agent signs → facilitator verifies and settles (pays the gas) → answer + `PAYMENT-RESPONSE` → signed HCS audit event;
   - the settled chat txs `0.0.9185802@1794018731.489265813` / `0.0.9185802@1794018738.510280927` and the top-up `0.0.9185802@1794011853.698529921`, with HashScan links;
   - how to run the agent and the top-up client (`pnpm --filter @gpupool/agent-client start`, `… topup --hbar 1`);
   - where laptop owners get paid (epoch payout and claim).

---

### M4. Demo video (≤ 5 min) showing a payment settling, with its HashScan link

**Video:** [Hedera x402 Payment](https://www.youtube.com/watch?v=zQ4D1H8n550) (https://www.youtube.com/watch?v=zQ4D1H8n550)

It walks through the whole x402 payment layer: the 402 challenge, the agent signing and paying with no human, settlement through the facilitator, the HashScan link, and the signed HCS audit event.

Settled transaction shown: `0.0.9185802@1794011853.698529921`, https://hashscan.io/testnet/transaction/0.0.9185802-1794011853-698529921

---

## Extra points

### E1. Spending controls for agents

**What exists**
- **Total budget:** `AGENT_BUDGET_HBAR`. The agent checks the price before each payment and stops before it would go over (`canAfford` in `agent-client/src/budget.ts`).
- **Per-payment maximum:** the x402 client refuses a quote above the remaining budget (`setSpendControls({ maxAmountPerPayment })`).
- **Asset allowlist:** the agent accepts only the configured asset (HBAR, or USDC with `--asset usdc`) via `allowedAssets` and a policy filter.
- **API-key spending cap:** keys can be created with a credit cap (`pnpm api-key create … --cap <credits>`).
- **Network guard:** the agent refuses to run if `HEDERA_NETWORK` is not `testnet`.
- **Seen live:** with a 0.02 HBAR budget the agent paid two 0.01 HBAR requests and reported `spent 2000000 tinybar (0.02 HBAR) of budget 0.02 HBAR`.

### E2. Agent identity and reputation (ERC-8004)

**What exists**
- An ERC-8004 registration document served at `/.well-known/agent-registration.json` (type `eip-8004#registration-v1`, with OpenAI / models / web endpoints). It was confirmed live in run #1.
- `gateway/scripts/register-agent.ts`: registers with an ERC-8004 identity registry on Hedera testnet (preview by default, `--broadcast` to send).
- `gateway/scripts/agent-feedback.ts`: the real x402 payer posts receipt-linked reputation feedback (preview by default).

### E3. HCS topic as a tamper-evident audit log of each agent's spending

**What exists**
- Every money event is **ed25519-signed** by the gateway and written to the HCS topic **`0.0.11332608`**, in order, with retries. The writer never blocks a request.
- Agent-spending events:
  - `x402_payment`: payer account, **Hedera tx ID**, tinybar amount, asset, model, tokens, **route of laptops (layers)**, prompt and response hashes;
  - `credits_purchased`: account, **agent key ID**, payer, tx ID, tinybars, credits added (idempotent per tx ID);
  - `request_settled`: cost, `key_mc` (credits bought by the key), split to nodes, burn and reserve;
  - `epoch_closed` / `payout_claimed`: provider payouts.
- Anyone can verify an event without secrets:
  - the `/ledger` page checks each event on the mirror node;
  - `node gateway/src/verify-event.ts <seq> <gateway_pubkey>` prints `signature: valid` or `INVALID`.
- Gateway public key: `0x9750f108f4273406aa7498086fc73b404633e5750d9f1d3dacfd95c1cc58c508`.

**Evidence**
| Item | Value |
|---|---|
| `credits_purchased` for the top-up | **HCS #104**, tx `0.0.9185802@1794011853.698529921`, 100,000,000 tinybar → 10,000 mc, **signature valid**, consensus `1794011861.708352384` |
| Agent payments (earlier run) | `x402_payment` HCS #20–22 |
| Backend check | `verify-backend`: `ledger_and_hcs` passed, 70 HCS-confirmed events |

**What is not there:** a per-agent spending view (one page or query filtered by agent). Today this needs filtering ledger events by payer or `agent_id`.

**Known gap:** if a pool fails **after** an x402 payment settled, the HBAR stays in the treasury (no refund) and the request is marked failed in SQLite, but **no HCS event is written** for that case, only a server log line.

### E5. Settling in an HTS token (USDC) and revenue split

**What exists**
- **USDC settlement is built.** The gateway offers USDC (`0.0.429274`, 6 decimals) beside HBAR at a fixed rate (1 USDC base unit = 500 tinybar). The agent pays with `--asset usdc`. `x402_payment` records the asset and raw amount.
- `gateway/scripts/associate-usdc.ts`: checks the treasury's token association (preview) and can associate it (`--broadcast`).
- **Revenue split:** 80% of x402 income goes to laptop owners **by layers served**, 10% to reserve and 10% to operations, through the `EpochPayout` contract (Merkle claim, payout contract `0x22aafc9cbdafd4e5a7e7eae47b27cad48ad8b82c`).

---

## Evidence still to capture (run #2, with the pool serving)

| Item | Guide step |
|---|---|
| Raw 402 challenge on `/v1/chat/completions` (decoded `accepts[0]`) | Step 1 |
| 3 agent chat payments: tx IDs, HashScan, mirror SUCCESS, `x402_payment` HCS #s with route, signature valid | Step 2 |
| Budget stop line (budget 0.03 HBAR) | Step 3 |
| Bought credits spent: `request_settled` HCS #, `key_mc`, split to laptop owners | Step 4 |
| Epoch close: `epoch_closed` HCS #, per-owner payouts (80% by layers) | Step 5 |
| Owner claim: claim tx, `payout_claimed` HCS #, repeat claim reverts | Step 6 |

Risk: an earlier epoch close failed on timeouts from the public `hashio.io` Hedera RPC. It works now; re-run one epoch if it repeats.

---

## Action checklist

- [ ] **Add the README "Payment flow (x402 on Hedera)" section** with tx `0.0.9185802@1794011853.698529921`, the HashScan link and HCS #104. Required.
- [x] Repo is public.
- [x] Pool serving; AI agent paid 2 chat requests on Hedera testnet.
- [x] **Demo video recorded:** https://www.youtube.com/watch?v=zQ4D1H8n550
