# GPU Pool Network — High-Level Design

Laptops on one LAN form a **pool** that runs a model no single laptop can run (Parallax splits the
layers). A **hosted gateway** sells that compute through an OpenAI-compatible API, pays providers in
proportion to the layers they serve, and records every balance change on Hedera.

## 1. System diagram

```mermaid
flowchart LR
  subgraph Buyers["Buyers"]
    U1["Browser user<br/>World ID or wallet"]
    U2["API key gpk_…<br/>opencode / OpenAI SDK"]
    U3["AI agent<br/>x402 per request"]
  end

  subgraph Web["Web app"]
    W1["User page<br/>chat · models · API keys<br/>buy credits · receipts"]
    W2["Provider page<br/>Start a pool / Join a pool<br/>World ID required"]
    W3["Network page<br/>pool health (Arkiv)"]
  end

  subgraph GW["Hosted gateway"]
    G1["OpenAI-compatible API<br/>+ auth (JWT, API keys, x402)"]
    G2["Router<br/>pool reliability × (1 − load)<br/>ratio queue · failover"]
    G3["Billing + ledger<br/>hold → settle<br/>90% nodes · 5% burn · 5% reserve"]
    G4["Reputation<br/>pool + node scores"]
    G5["Settlement<br/>epoch Merkle → contract"]
    DB[("Gateway DB<br/>SQLite → Postgres")]
  end

  subgraph Pool["Pool (same LAN, ≤ 5 ms)"]
    C1["Coordinator<br/>parallax run + agent<br/>outbound tunnel"]
    N1["Member<br/>parallax join + agent"]
    N2["Member<br/>parallax join + agent"]
  end

  subgraph Public["Public record"]
    A1[("Arkiv<br/>pools · nodes · models<br/>account stats")]
    H1[("Hedera HCS<br/>signed ledger events")]
    H2["Treasury + x402<br/>(HBAR)"]
    H3["EpochPayout<br/>contract"]
  end

  U1 --> W1
  W1 & W2 --> G1
  U2 --> G1
  U3 --> G1
  W3 -.-> A1

  G1 --> G2
  G2 <-->|"tunnel"| C1
  C1 --- N1 & N2
  N1 & N2 & C1 -->|"heartbeats"| G4
  G4 --> DB
  G1 --> G3 --> DB

  C1 & N1 & N2 -->|"listings"| A1
  G2 -.->|"ready pools"| A1
  G3 -->|"every balance change"| H1
  U3 & W1 -->|"HBAR"| H2 --> G3
  G5 --> H3
  W2 -->|"claim HBAR"| H3
```

## 2. Components

| Component | Responsibility | Built? |
|---|---|---|
| **User page** | Chat (model picker from Arkiv), receipts (route, layers, cost, HCS link), balance + ratio, API keys, buy credits | Chat/receipts ✅ · API keys & buy credits: in progress (friend) |
| **Provider page** | "Start a pool" / "Join a pool" guides, info exchange, firewall rules, my nodes, earnings, payouts | Guide + node confirm ✅ · two-role page: to build |
| **Network page** | Pool health from Arkiv: status, reliability, members, capacity, layer map, model, heartbeats | ✅ |
| **World ID** | One account per human (Orb or Selfie). **Required for providers**; gives 10,000 starter credits | ✅ live-tested (simulator) |
| **Wallet sign-in + API keys** | Buyers without World ID; `gpk_…` keys work with any OpenAI-compatible client | Planned (friend) |
| **Gateway API** | OpenAI-compatible; the only public entry point | ✅ |
| **Router** | Arkiv ready pools → filters (fresh heartbeats, complete layers, not restarting) → `pool reliability × (1 − load)` → per-pool priority queue (ratio) → 1 failover → 503 + Retry-After | ✅ |
| **Billing / ledger** | Hold max cost, settle real cost, split 90/5/5 by layers, self-request → reserve, vesting 1 h | ✅ |
| **Reputation** | **Pool** (router score): 0.7 × success + 0.3 × uptime. **Node**: blame, caps, display | ✅ |
| **Settlement** | Each epoch: x402 (+ purchased credits) income → 80% providers by layers → Merkle root → contract | ✅ (x402) |
| **Coordinator** | `parallax run` scheduler (API private), node agent, **outbound tunnel** to the hosted gateway | Scheduler ✅ · tunnel: to build |
| **Members** | `parallax join -s <coordinator>`; node agent (heartbeats, Arkiv listing) | ✅ |

## 3. Data stores

| Store | What lives there | Why there |
|---|---|---|
| **Gateway DB** | `balances` (starter / earned / vesting / held), `earned_lots`, `requests` + receipts, `nodes`, pool & node reliability, API keys, epochs/payouts | Fast, private working copy for money logic |
| **Hedera HCS** | Signed event for every balance change (`starter_grant`, `request_settled`, `x402_payment`, `credits_expired`, `epoch_closed`, `payout_claimed` …) | Public audit log; balances can be rebuilt from it |
| **Arkiv** | Pools (models, members, status, layer map, **reliability**), nodes (GPU, memory, layers, tok/s, reliability, owner), models, account stats | Public directory; listings expire when a machine stops |
| **EpochPayout contract** | Merkle root + HBAR per epoch; claims | Trust-minimised HBAR payouts |

## 4. Key flows

**Buy and use compute**
1. User logs in (World ID → 10,000 starter credits) or signs in with a wallet and buys credits; or uses an API key; or an agent pays per request with x402.
2. Gateway router picks the best ready pool → request goes down the coordinator's tunnel → Parallax runs the layers across the pool → tokens stream back.
3. Gateway settles the real cost: 90% to node owners by layers served (0 on their own requests), 5% burn, 5% reserve → event on HCS → receipt shows route, cost, HCS link.

**Provide compute**
1. Owner verifies with World ID (mandatory).
2. Coordinator: `gpupool-node coordinate` → starts the scheduler + tunnel → registers the pool → shares the join card (scheduler address, network name, model, flags).
3. Members: `gpupool-node join --pool <id>` → delay check (≤ 5 ms to every member) → join request → coordinator approves → firewall rules between member IPs → `parallax join -s …`.
4. Pool turns **ready** when every layer is covered exactly once → elected member publishes the pool listing (+ pool reliability) on Arkiv.
5. Earnings: credits per request (vest 1 h, spend on any pool) and HBAR per epoch from paid demand (claim from the contract).

**Info a pool must exchange**

| From → to | Information |
|---|---|
| Coordinator → members | Scheduler multiaddr `/ip4/<LAN-IP>/tcp/5100/p2p/<peer-id>`, private network name, model (+ MLX variant), Parallax commit, flags |
| Member → coordinator | LAN IP, P2P port, peer ID (admission allow-list), GPU + memory |
| Coordinator ↔ gateway | Authenticated tunnel (coordinator dials out; no inbound port) |
| Every member ↔ every member | Firewall allow on each P2P port (TCP + UDP), pool member IPs only; measured delay ≤ 5 ms |

## 5. Decisions and limits

| Topic | Decision |
|---|---|
| Database | **SQLite now** (single gateway, atomic credit holds, HCS is the audit trail). **Postgres for the hosted gateway** once there is more than one gateway instance or managed backups/HA are needed. |
| Pool reach | Same LAN only (every pair ≤ 5 ms). Pools over the internet need relays: later. |
| Parallax API | Never public: stays on the coordinator's `127.0.0.1`; only the tunnel reaches it. |
| Reputation identity | The **pool** (router score); node scores for blame, caps, display. |
| Output verification | Designed, **disabled** (`VERIFICATION_ENABLED=false`); to be redesigned. |
| Payments | Testnet only: HBAR x402, HCS ledger, EpochPayout on Hedera testnet. |
