# GPU Pool

Large AI models exceed the memory of many everyday laptops, while nearby GPUs sit idle.
Connecting those machines is only half the problem: an open network also needs identity, live discovery, fair accounting and payments.

**GPU Pool combines nearby Apple and NVIDIA computers into one model-serving pool.** Providers contribute compute and earn credits; anyone can send prompts through an OpenAI-compatible API using credits or x402 payments. Built for ETHGlobal Mumbai 2026, with Qwen3-14B tested across an M4, an M5 and an RTX 4060 over Ethernet.

[Live app](https://gpupool-ethglobal.vercel.app) · [API keys](https://gpupool-ethglobal.vercel.app/keys) · [Architecture board](https://www.tldraw.com/f/Kq9M9uby0mhMJEGD5rgsq)

## Our approach

The **gateway chooses a pool; Parallax chooses its GPU stages**. Model layers stay on the workers, which exchange hidden states over Ethernet. A scoped outbound relay connects each private coordinator to the central gateway. Marketplace signing and payment keys stay central.

```mermaid
flowchart TD
    Client[OpenCode / Client] -->|request| Gateway[API Gateway]
    Gateway --> Router[Pool Router]
    Router -->|relay| Coordinator[Parallax Coordinator]
    Coordinator --> M4[M4 · MLX]
    M4 --> M5[M5 · MLX]
    M5 --> RTX[RTX 4060 · FP8]
    RTX -->|tokens| Gateway
    Gateway -->|SSE| Client

    World[World ID] -->|login| Gateway
    Payment[x402 · Hedera] -->|pay| Gateway
    Agents[Node Agents] -->|publish| Arkiv[Arkiv Directory]
    Arkiv -->|discover| Router
    Agents -->|heartbeat| Router

    Gateway -->|usage| Ledger[SQLite Ledger]
    Ledger -.->|audit| HCS[Hedera HCS]
    Ledger -.->|epoch| Payout[Merkle Payouts]
    Payout -->|HBAR| Wallet[Provider Wallet]
```

- **World ID** links accounts and budgeted API keys to verified humans.
- **Arkiv** provides expiring node/pool listings. Routing also checks fresh signed heartbeats and layer coverage.
- **SQLite + Hedera** handle atomic credit holds, usage settlement and an asynchronous signed audit trail. Credits split 90% to serving nodes by layers, 5% burn and 5% reserve. Successful direct x402 requests allocate 80% of HBAR income to providers through epoch-based Merkle claims.
- **OpenCode tools run on the requester’s laptop.** The gateway translates model tool calls into the OpenAI protocol.

## Set up and use

### Call the live API

Log in with World ID on the [app](https://gpupool-ethglobal.vercel.app), create a capped key on **Keys**, and export it locally:

```bash
export GPUPOOL_API_KEY='your-api-key'
export GPUPOOL_BASE_URL='https://ethglobal.yash-agrawal.dev'

curl "$GPUPOOL_BASE_URL/v1/chat/completions" \
  -H "Authorization: Bearer $GPUPOOL_API_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"model":"Qwen/Qwen3-14B-FP8","messages":[{"role":"user","content":"Explain GPU pooling briefly."}],"max_tokens":128,"stream":true}'
```

Available models: `GET /v1/models`. For **OpenCode**, copy the configuration from Keys into your project’s `opencode.json`, then run `opencode`. See the [OpenCode guide](docs/OPENCODE.md) for configuration and context limits. Requests require a ready pool and spend credits; x402 payments use Hedera testnet.

### Contribute a laptop

Open [Become a provider](https://gpupool-ethglobal.vercel.app/getting-started). Choose **Create Pool** or **Join Pool ID**, log in with World ID, and enter your payout address. The coordinator approves members; each owner runs the generated one-command helper locally.

The helpers discover Ethernet IPs, prepare dependencies, download each model format once on the coordinator, transfer and verify caches, and synchronize node startup. Keep the helper running; progress appears on the frontend. Supported hosts need Python 3.10+, Git, Apple developer tools or working NVIDIA drivers, and owner-approved network access. Details: [provider onboarding](docs/PROVIDER-ONBOARDING.md).

### Run your own gateway and frontend

Requires **Node.js 24+** and **pnpm**:

```bash
git clone https://github.com/agrawalx/Ethglobal-mumbai.git
cd Ethglobal-mumbai
pnpm install
cp -n gateway/.env.example gateway/.env
cp -n frontend/.env.example frontend/.env.local
```

Configure `gateway/.env` with your World, JWT/signing, Arkiv and Hedera testnet credentials. Set `PUBLIC_URL` to the reachable gateway URL and `CORS_ORIGINS` to your frontend origin. Set `VITE_GATEWAY_URL` in the frontend; platform secrets belong only on the gateway. A fresh deployment also needs the Arkiv model catalog seeded, funded directory writers and a deployed payout contract for HBAR claims.

Run in separate terminals:

```bash
pnpm --filter @gpupool/gateway start   # localhost:8080
pnpm --dir frontend dev              # localhost:5173
```

Use trusted HTTPS for World phone login and remote helpers. Then onboard a pool through the frontend; starting the web services alone does not create inference capacity. See [gateway configuration](gateway/README.md), [pool bootstrap](docs/POOL-KICKSTART.md) and the [live runbook](docs/LIVE-DEMO-RUNBOOK.md).

## What challenged us

- **Mixed hardware:** NVIDIA FP8 and Apple MLX need different model snapshots but must serve the same layer pipeline.
- **Mac memory pressure:** oversized KV caches caused swapping and stalls. Bounded caches and a 4K sequence limit made the tested pool usable.
- **Pool lifecycle:** stale peers, orphaned processes and untimed joins broke placement. Process-group cleanup, runtime hooks and synchronized starts helped recovery.
- **Agent compatibility:** tool schemas, small context windows and missing stream finish markers made OpenCode harder than ordinary chat. The adapter must preserve tool turns and completion semantics.
- **Accounting across services:** inference, HCS and chain settlement finish at different times. Atomic local transactions, durable retries and explicit pending receipts keep those states separate.

## What’s next

- Redesign and calibrate **output verification**; it is currently disabled.
- Improve recovery from failed pipeline stages and reduce coordinated restarts.
- Tune batching, context capacity and model placement across more hardware, including MoE models.
- Test WAN pools and make installation and network diagnostics easier.
- Batch provider claims to reduce gas overhead; harden the system before considering mainnet payments.

For implementation details, see the [specification](docs/SPEC.md) and [engineering handoff](docs/HANDOFF.md).

## Sponsor tracks

### Track requirements

| Track | Requirement | Where it is met |
|---|---|---|
| **Arkiv** | Explain what users would lose without Arkiv, what stays off-chain, and how filters, ownership and expiry fit the app | [Why Arkiv](arkiv/why-arkiv.md), [How we use Arkiv](arkiv/how-you-use-arkiv.md) |
| **Hedera: AI Agents That Pay (x402)** | An x402-protected endpoint settled on Hedera through a listed facilitator; an agent that pays with no human approval; a settled transaction ID in the README; a demo with a HashScan link | `POST /v1/chat/completions` (402 → x402 on `hedera:testnet` via `x402.org/facilitator`), `agent-client/`, transactions below |
| **Hedera extras** | Spending controls; HCS as a tamper-evident audit log; revenue split to providers | Agent budget cap; signed events on HCS topic `0.0.11332608`; `EpochPayout` contract |
| **World: Best Use of IDKit** | IDKit in a working app, server-side proof verification, a product event that needs a unique human, the minimum sufficient credential, success and failure paths | [World ID submission](docs/WORLD_IDKIT_SUBMISSION.md) |

### Arkiv

- **Catalog writer wallet:** `0xfeb19eb223236427a31b2d909851025abc55db1b` writes the `gpupool.model` entities. Each laptop writes its own `gpupool.node` entity with its node wallet, and the elected pool writer signs `gpupool.pool`.
- **Network:** Arkiv testnet "Rabdi", chain ID `7794095`.
- **Docs:** [Why Arkiv](arkiv/why-arkiv.md) · [How we use Arkiv](arkiv/how-you-use-arkiv.md) · code in [`arkiv/`](arkiv/) ([schemas and filters](arkiv/src/schema.ts), [owner-scoped writes](arkiv/src/writer.ts), [reads](arkiv/src/reader.ts)).
- **A query you can run:** list the model catalog straight from Arkiv (`select … from gpupool.model`):

  ```bash
  cd arkiv && node --env-file=.env src/cli.ts list-models
  # → Qwen/Qwen3-8B-FP8, Qwen/Qwen3-14B-FP8, Qwen/Qwen3-30B-A3B-Instruct-2507-FP8
  ```

  The router runs `node src/cli.ts list-ready-pools <model>`: pools where `status = ready` and the model is listed.

### Hedera x402 payments

Status: **working on Hedera testnet.** An AI agent pays 0.01 HBAR per request with x402 and gets its answer; nobody approves it. Settled transactions (agent `0.0.11332604` → treasury `0.0.11331600`, network fee paid by the facilitator `0.0.9185802`):

| x402 payment | HCS audit event |
|---|---|
| [`0.0.9185802@1794018731.489265813`](https://hashscan.io/testnet/transaction/0.0.9185802-1794018731-489265813) | #133 `x402_payment`, signature valid |
| [`0.0.9185802@1794018738.510280927`](https://hashscan.io/testnet/transaction/0.0.9185802-1794018738-510280927) | `x402_payment` |
| [`0.0.9185802@1794016987.106070928`](https://hashscan.io/testnet/transaction/0.0.9185802-1794016987-106070928) | #115 `x402_payment` |
| [`0.0.9185802@1794016459.379155319`](https://hashscan.io/testnet/transaction/0.0.9185802-1794016459-379155319) | #111 `x402_payment`, signature valid |
| [`0.0.9185802@1794011853.698529921`](https://hashscan.io/testnet/transaction/0.0.9185802-1794011853-698529921) (x402 top-up: 1 HBAR → 10 credits) | #104 `credits_purchased`, signature valid |

- **HCS audit topic:** [`0.0.11332608`](https://hashscan.io/testnet/topic/0.0.11332608), signed by the gateway (public key `0x9750f108f4273406aa7498086fc73b404633e5750d9f1d3dacfd95c1cc58c508`). Verify any event with `cd gateway && node --env-file=.env src/verify-event.ts <seq> <pubkey>`.
- **Provider payouts:** `EpochPayout` contract `0x22aafc9cbdafd4e5a7e7eae47b27cad48ad8b82c` (Hedera EVM, chain 296).
- **Docs:** [x402](gateway/README.md#x402-step-24), [HCS](gateway/README.md#hcs-step-23), [epoch settlement and payouts](gateway/README.md#epoch-settlement-and-provider-payouts-step-33), [agent client](agent-client/).

### World ID

- **IDKit v4**, action `gpupool-account`, credentials **Orb (`proof_of_human`) or Selfie Check (`selfie`)**; one account per nullifier.
- **Configuration (public values from `gateway/.env`):**

  | Key | Value |
  |---|---|
  | `WORLD_APP_ID` | `app_3defa81f175967a96109b1a628927bb6` |
  | `WORLD_RP_ID` | `rp_831104fa5fd04dd5` |
  | `WORLD_ACTION` | `gpupool-account` |
  | `WORLD_ENVIRONMENT` | `staging` (World ID Simulator) |
  | `WORLD_SIMULATOR_DEVICE_ACCOUNTS` | `true`: staging only; the simulator returns one nullifier for every identity, so accounts are keyed per browser until real World App logins |
  | `WORLD_RP_SIGNING_KEY` | server-only; signs each IDKit request in the gateway and never reaches the browser |

- **Flow:** the gateway signs the request (`/auth/world/rp-signature`), the browser runs IDKit, and the gateway verifies the proof with World's v4 verify API (`/auth/world/verify`). A new human gets 10,000 starter credits, recorded as a signed event on HCS.
- **Docs:** [World ID submission](docs/WORLD_IDKIT_SUBMISSION.md) · code: [`gateway/src/world.ts`](gateway/src/world.ts), [`frontend/src/auth/LoginSheet.tsx`](frontend/src/auth/LoginSheet.tsx).
