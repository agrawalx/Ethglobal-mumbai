# GPU Pool Network: MVP Specification

**Version:** 0.1 (MVP)
**Writing standard:** ASD-STE100 (Simplified Technical English), about 80%. Code, tables, and names do not follow the standard.
**Rule for this document:** Build the minimum that works. Do not add complexity that the MVP does not need. Do not design against the post-MVP items in Section 16.

---

## 1. MVP goal

A user on a laptop **outside** the pool sends a request. A **3-node pool** runs the model. The user pays with credits or with x402. The system records the payment. The system divides the credits between the nodes that served the request.

### 1.1 Demo

1. A user opens the web app on a laptop outside the pool.
2. The user logs in with World ID. The user gets starter credits.
3. The user selects a model. The model list comes from Arkiv.
4. The user sends a prompt. The 3-node pool sends the answer.
5. The screen shows the route (node and layers), the cost, and the new balance.
6. The ledger event appears on Hedera HCS. HashScan shows it.
7. An AI agent on the same laptop sends a request and pays with x402. HashScan shows the payment.
8. The node owners see their earned credits and their reliability scores.
9. The epoch closes. The gateway posts the payout to the contract. A node owner claims HBAR. HashScan shows the claim.

### 1.2 Demo hardware

| Role | Machine | Notes |
|---|---|---|
| Node 1 + pool coordinator | Linux laptop, RTX 4060 8 GB | Runs the Parallax scheduler and one node |
| Node 2 | MacBook Air M4 16 GB | Parallax node (MLX) |
| Node 3 | MacBook Air M5 16 GB | Parallax node (MLX) |
| Requester | A fourth laptop on the same network | Browser and AI agent script only |
| Gateway | Linux laptop (MVP) | Can move to a different machine later |

All nodes use wired Ethernet. All nodes download the model before they join.

---

## 2. Architecture

```
 Requester laptop (outside the pool)
   ├─ Browser ── World ID login ──┐
   └─ AI agent ── x402 payment ───┤
                                  ▼
                         ┌──────────────────┐
                         │     GATEWAY      │  OpenAI-compatible API
                         │  auth · router   │  credit ledger (SQLite)
                         │  credits · reps  │
                         └───┬─────────┬────┘
                 HCS events  │         │ reads pools / models
                             ▼         ▼
                         HEDERA      ARKIV  ◄── node agents write node listings
                             ▲                   coordinator writes pool listing
                    x402 settle
                                  │ HTTP (private network only)
                                  ▼
                   ┌────────────────────────────┐
                   │ POOL (Parallax)            │
                   │ coordinator: scheduler     │
                   │ nodes: 4060 · M4 · M5      │
                   └────────────────────────────┘
```

### 2.1 Components

| # | Component | Language | Owner |
|---|---|---|---|
| C1 | Pool runner (Parallax setup scripts) | Shell / Python | Inference |
| C2 | Node agent | Python | Inference |
| C3 | Gateway: API, auth, router, ledger, reliability | TypeScript | Backend |
| C4 | World login | TypeScript (inside gateway) + frontend widget | Identity |
| C5 | x402 payments | TypeScript (inside gateway) | Hedera |
| C6 | Hedera integration (HCS, accounts) | TypeScript | Hedera |
| C7 | Arkiv integration | TypeScript (gateway) + Python or TS (node agent) | Arkiv |
| C8 | Frontend | Next.js | Frontend |
| C9 | AI agent client | TypeScript | Hedera |
| C10 | Payout contract (`EpochPayout.sol`) and settlement job | Solidity (Foundry or Hardhat) + TypeScript | Hedera |

---

## 3. C1: Pool runner

The pool runner starts one Parallax pool with 3 nodes. It uses the settings that we tested on 6 Nov.

### 3.1 Settings

| Setting | Value | Reason |
|---|---|---|
| Model | `Qwen/Qwen3-14B-FP8` (Macs load `Qwen/Qwen3-14B-MLX-8bit`) | Tested. No single node can run it. |
| Network name | `--dht-prefix <private-name>` | The default name is shared with all Parallax users. |
| Ports | Fixed `--tcp-port` / `--udp-port` per node (5100 scheduler, 5101+ nodes) | Firewall rules need fixed ports. |
| Address | `--announce-maddrs /ip4/<lan-ip>/...` | Stops Docker bridge addresses being advertised. |
| Telemetry | `-u` on every command | Stops upload of package info to Gradient. |
| Mac memory | `--kv-cache-memory-fraction 0.25 --max-sequence-length 4096` | Decreased swap by 88% in our test. |
| CUDA node | `CUDA_HOME` set to the nvcc inside the Parallax environment | Needed for kernel compilation. |
| Model files | Download before join; then `HF_HUB_OFFLINE=1` | A download during join fills the link. |

### 3.2 Start procedure

1. Stop all old Parallax processes on all nodes. Stop the full process group.
2. Start the scheduler on the coordinator.
3. Start all 3 node joins **within 30 seconds** of each other. (Parallax drops a node that waits longer. Post-MVP fixes this.)
4. Wait until all nodes show "ready".
5. Send one warm-up request.

### 3.3 Scripts

- `pool/start-scheduler.sh` — on the coordinator.
- `pool/join-node.sh` — on each node. It reads `node.env` (IP, ports, model, network name, memory flags).
- `pool/stop-all.sh` — stops the full process group.
- `pool/status.sh` — calls `GET http://127.0.0.1:3001/cluster/status_json` on the coordinator.

The Parallax HTTP API (port 3001) stays on `127.0.0.1`. Only the gateway can call it.

---

## 4. C2: Node agent

The node agent is a small Python program on each node. It does not replace Parallax. It runs next to it.

### 4.1 Functions

| Function | Description |
|---|---|
| **Identity** | It creates a node key (EVM wallet) at first start. It stores the key in `~/.gpupool/node.key`. |
| **Registration** | It prints a link. The owner opens the link, logs in with World, and confirms the node. The gateway links the node to the owner account. |
| **Arkiv listing** | It creates a `gpupool.node` entity. It extends the expiry every 30 seconds. |
| **Heartbeat to gateway** | It sends status every 10 seconds: online, model loaded, layers, tokens per second. It reads its layer range from the local Parallax node log (Section 5.5). It signs the raw body with the node key. |
| **Start / stop** | It calls `join-node.sh` and `stop-all.sh`. |

### 4.2 Commands

```
gpupool-node init          # create key, print registration link
gpupool-node start         # start Parallax join + Arkiv listing + heartbeat
gpupool-node stop          # stop the process group, set listing to offline
```

`start --no-join` runs the agent next to a Parallax node that already runs. `stop --keep-parallax` stops only the agent.
The coordinator (`IS_COORDINATOR=true`) also writes `gpupool.pool` from `GET /pools/:pool_id` (Section 5.5).

---

## 5. C3: Gateway

The gateway is one TypeScript service (Node 24, Hono or Fastify). It is the only public entry point.

### 5.1 Functions

1. Authenticate the requester (World session or x402).
2. Select a pool for the requested model (router).
3. Hold the maximum cost, forward the request, settle the actual cost.
4. Divide the credits between the nodes on the route.
5. Write ledger events to SQLite and to Hedera HCS.
6. Update reliability scores.

### 5.2 Endpoints

| Method | Path | Auth | Description |
|---|---|---|---|
| POST | `/v1/chat/completions` | Session token **or** x402 | OpenAI-compatible. Streaming and non-streaming. |
| GET | `/v1/models` | None | Models that a live pool can serve now. Source: Arkiv. |
| POST | `/auth/world/rp-signature` | None | Signs the IDKit request (server side). |
| POST | `/auth/world/verify` | None | Verifies the IDKit proof. Creates the account. Returns a session token. |
| GET | `/me` | Session | Balance, ratio, nodes, reliability. |
| POST | `/nodes/register` | Session | Links a node key to the account. |
| POST | `/nodes/heartbeat` | Node key signature | Node status and layer range. Response: owner account and reliability (for the Arkiv listing). |
| GET | `/pools/:pool_id` | None | The gateway's view of a pool: members with a fresh heartbeat, layer map, status. The coordinator writes `gpupool.pool` from it. |
| GET | `/requests/:id` | None | Receipt: route, cost, HCS sequence number. |
| GET | `/network` | None | Pools and nodes (for the frontend). |
| GET | `/ledger/events` | None | Recent ledger events with HCS sequence numbers (for the `/ledger` page). |
| GET | `/payouts/:address` | None | Epoch payouts and Merkle proofs for a payout address (for the `/payouts` page). |

Request and response bodies, headers, and the error shape are in `shared/` (`shared/README.md`).

### 5.3 Request flow

1. The gateway reads the `model` field.
2. If the request has a session token, the gateway checks the balance. If the request has no token, the gateway applies x402 (Section 7). An invalid token gets HTTP 401 (never x402).
3. The router selects a pool (Section 5.4).
4. The gateway holds `model_factor × (max_tokens + 0.2 × input_tokens)` credits. Before the request runs, `input_tokens` = ceil(characters of all messages / 4). If the balance is too small, the gateway returns HTTP 403 `insufficient_credits`.
5. The gateway forwards the request to the pool coordinator. It forces `enable_thinking: false` unless the user asks for it.
6. The gateway streams the answer to the user.
7. At the end, the gateway reads the token counts from `usage`.
8. The gateway settles the actual cost (never more than the hold). It returns the remaining hold.
9. The route is the pool's layer map when the request starts (Section 5.5).
10. The gateway writes a receipt and a ledger event.
11. If the request fails, the user pays nothing. The nodes on the route get a reliability penalty (Section 9). If the client stops the request before the answer is complete, the user pays nothing and the nodes get no penalty (provisional, step 2.2). If the answer is complete (the `usage` arrived), the gateway settles it normally.

### 5.4 Router

The router selects the pool for a model. In the MVP there is one pool. The router still uses this rule, so that more pools work later without a change.

1. Read all `gpupool.pool` entities from Arkiv that list the model and have `status = ready`.
2. Remove pools whose last heartbeat to the gateway is older than 30 seconds.
3. Select the pool with the highest score: `score = reliability × (1 − load)`.
4. If no pool is available, return HTTP 503 with `Retry-After`.

The router does not select nodes inside the pool. Parallax does that.

### 5.5 Route capture (MVP method)

- In the MVP, the pool has one pipeline. Each request goes through all nodes in the pool.
- Parallax `GET /cluster/status_json` has **no** layer ranges (only libp2p peer IDs and status). So each **node agent reports its own layer range** in its signed heartbeat (`NodeHeartbeat.layers`).
- The node agent reads the range from its local Parallax node log (Parallax is not changed). It uses the last of these lines: `Join scheduler response: {… 'start_layer': S, 'end_layer': E …}`, `Layer allocation changed! … New: [S, E)`, `Reloading executor with layers [S, E)`.
- The gateway builds the pool's layer map from the latest **fresh** heartbeats (30 s or newer) of the pool's registered nodes. The map is valid only if the ranges cover `[0, num_layers)` of the model **exactly once** (no gaps, no overlaps). `num_layers` is in the model config (Qwen3-14B = 40, Qwen3-8B = 36).
- The route of a request is the valid layer map when the request starts.
- If the map is not valid, the route is **unknown** (`null`). The gateway logs a warning. The node shares of that request go to the network reserve (credits), or stay in the treasury (x402).
- Post-MVP: capture the exact route of each request from the Parallax scheduler.

---

## 6. C4: World login

### 6.1 Setup

- World Developer Portal: one app, one RP, one action: `gpupool-account`.
- Environment: staging with the simulator for the hackathon.
- Credentials: **Orb** or **`selfieCheck`**. The user can verify with either one. Both give one account and the same starter credits.

### 6.2 Flow

1. The frontend asks the gateway for an RP signature (`/auth/world/rp-signature`). The signing key stays on the server. The gateway signs with `signRequest` from `@worldcoin/idkit-core/signing` (secp256k1). The signature is valid for 300 seconds.
2. The frontend opens the IDKit widget (`@worldcoin/idkit` v4).
3. The user completes Orb verification or Selfie Check in the World App (simulator in staging).
4. The frontend sends the result to `/auth/world/verify` **without changes**.
5. The gateway sends the result to `POST https://developer.world.org/api/v4/verify/{rp_id}` (no auth header). The gateway accepts only Orb (`proof_of_human`) or Selfie Check (`selfie`) results. Any other result, or a World error, gives HTTP 401.
6. The gateway stores the nullifier (32-byte lowercase hex) with a UNIQUE constraint. World accepts a reused nullifier (HTTP 200, "nullifier reuse"). So this constraint is the only check for "one account for each human".
7. If the nullifier is new, the gateway creates an account and gives the starter credits.
8. If the nullifier exists, the gateway logs in to the existing account. It does not give starter credits again.
9. The gateway returns a session token (JWT, 24 hours).

### 6.3 Rules

- One account for each nullifier.
- Maximum 3 nodes for each account in the MVP.
- Starter credits: one time only.

### 6.4 Demo paths (for the World track)

- Success: a new user logs in and gets starter credits.
- Failure: the same human tries a second account. The gateway shows "already registered" and gives no credits.
- Cancel: the user closes the widget. Nothing changes.

---

## 7. C5: x402 payments

### 7.1 Purpose

AI agents and users without credits pay for each request. They do not need an account.

### 7.2 Flow

1. The agent sends a request with no session token and no payment.
2. The gateway returns HTTP 402 with the price and the treasury account.
3. The agent signs a payment and sends the request again with the payment header.
4. The facilitator checks and settles the payment on Hedera testnet. The gateway settles **before** it sends the request to the pool.
5. The gateway serves the request. If the pool fails after the payment, the gateway records the request as failed. There is no refund in the MVP.
6. The gateway records the payment in the ledger (`requests` row with payer, transaction, amount, route) and on HCS (`x402_payment`, for served requests).

### 7.3 Prices (MVP)

| Model | max_tokens ≤ 512 | max_tokens ≤ 2048 |
|---|---|---|
| ≤ 8B | 0.01 HBAR | 0.03 HBAR |
| 14B | 0.02 HBAR | 0.06 HBAR |

- Currency: HBAR on testnet. USDC is post-MVP.
- Facilitator: the x402.org facilitator (supports `hedera:testnet`, confirmed 6 Nov). Packages: `@x402/*` 2.30 (x402 v2). See `scripts/x402-poc/README.md`.

### 7.4 What happens to the money

- The payment goes to the treasury account.
- The gateway records each x402 request with its route (nodes and layers).
- At the end of each epoch, the providers get HBAR for the x402 requests that their nodes served (Section 10.5).
- x402 requests do not give credits to providers. Providers get HBAR for these requests instead.

---

## 8. C3 (part): Credit ledger and incentive rules

### 8.1 Credit unit and cost

```
1 credit = 1 output token on an 8B model at 8 bits
cost     = model_factor × (output_tokens + 0.2 × input_tokens)
cost_mc  = floor(model_factor × (output_tokens + 0.2 × input_tokens) × 1000)
```

| Model | model_factor |
|---|---|
| Qwen3-8B (8-bit / FP8) | 1.0 |
| Qwen3-14B (8-bit / FP8) | 1.75 |

The admin sets the factors in a configuration file.

### 8.2 Accounts and balances

| Item | Rule |
|---|---|
| Starter credits | 10,000 credits for each new verified human. They expire after 14 days. |
| Earned credits | Credits from requests that the account's nodes served. No expiry in the MVP. |
| Spending order | The gateway uses starter credits first, then earned credits. |
| Contribution ratio | `earned_total / max(spent_total, 1)`. Shown on the account page. |

### 8.3 Division of each request

| Part | Share |
|---|---|
| Nodes on the route | 90%, divided by the number of layers that each node served |
| Burn | 5% (removed from the system) |
| Network reserve | 5%, plus every rounding remainder |

Integer rule (millicredits): `nodes_share = floor(cost × 90%)`; each node gets `floor(nodes_share × layers / total_layers)`; burn = `floor(cost × 5%)`; reserve = cost − nodes − burn. The parts sum exactly to the cost.

**Self-request rule:** a node that the requesting account owns gets 0 credits for that request. Its share goes to the network reserve.

Example: a 14B request costs 490 credits (490,000 mc). Node M4 served 20 of 40 layers. Node M5 served 9. Node 4060 served 11. The nodes get 220,500, 99,225, and 121,275 mc. 24,500 mc are burned. 24,500 mc go to the reserve. If the requester owns M5, M5 gets 0 and the reserve gets 123,725 mc.

### 8.4 Rules from BitTorrent

| BitTorrent problem | BitTorrent solution | MVP rule |
|---|---|---|
| Cold start | Signup bonus, optimistic unchoke | Starter credits for each verified human (World ID). |
| Give now, use later | Share ratio on the tracker | Credits. The ratio is shown on the account page. |
| Fake ratio reports | Tracker checks peer reports | The gateway records the work. The node does not report its own earnings. |
| Self-dealing | (Ratio cheats) | A node gets 0 credits for a request from its own owner; its share goes to the network reserve. The burn fee makes back-and-forth trading cost credits. |
| Large files cost more | Size-based ratio | `model_factor`: a larger model costs more for each token. |
| Bad peers | Choking | Reliability score lowers the routing score of unreliable pools (Section 9). |
| Free riders | Choking | Priority: when requests wait, a higher ratio goes first (Section 8.5). |
| Sybil accounts | Invite-only trackers, bans | One account for each World ID nullifier. |

### 8.5 Priority (MVP)

- The gateway keeps one queue for each pool.
- If the pool is busy, waiting requests are sorted by the contribution ratio of the account. x402 requests have ratio 1.
- A low ratio does not block a request.

### 8.6 Ledger storage

- **SQLite** in the gateway keeps the balances. It is the fast source for the gateway.
- **HCS** keeps an event for each change. Anyone can rebuild the balances from HCS.
- Event types: `account_created`, `starter_grant`, `request_settled`, `x402_payment`, `credits_expired`, `payout_address_set`, `epoch_closed`, `payout_claimed`.

### 8.7 Gateway database (SQLite)

- The gateway uses **SQLite** (`better-sqlite3`, WAL mode). One file next to the gateway.
- The database is a fast working copy. HCS is the audit record. The gateway can rebuild the balances from HCS.
- Store the World nullifier as **TEXT** with a UNIQUE constraint. (The World docs show `NUMERIC(78,0)` for Postgres. SQLite does not have this type.)
- Postgres is post-MVP. Use it when more than one gateway runs.

| Table | Columns |
|---|---|
| `accounts` | `id` PK, `world_nullifier` TEXT UNIQUE, `payout_address`, `created_at` |
| `balances` | `account_id` PK/FK, `starter_mc`, `starter_expires_at`, `earned_mc`, `held_mc`, `earned_total_mc`, `spent_total_mc` |
| `nodes` | `node_id` PK (node public key), `account_id` FK, `pool_id`, `gpu`, `mem_gb`, `registered_at` |
| `node_reliability` | `node_id` PK/FK, `requests_routed`, `requests_ok`, `heartbeats_expected`, `heartbeats_received`, `score`, `updated_at` |
| `requests` | `req_id` PK, `account_id` FK (null for x402), `x402_payer`, `x402_tx`, `x402_amount_tinybar`, `model`, `pay_type` (`credits` / `x402`), `in_tokens`, `out_tokens`, `cost_mc`, `split` JSON, `route` JSON (node → layers), `status`, `prompt_hash`, `resp_hash`, `hcs_seq`, `ts` |
| `ledger_events` | `id` PK, `type`, `payload` JSON, `gateway_sig`, `hcs_seq` (null until written), `ts` |
| `epochs` | `epoch` PK, `start_ts`, `end_ts`, `total_tinybar`, `merkle_root`, `post_tx`, `status` |
| `epoch_payouts` | (`epoch`, `payout_address`) PK, `amount_tinybar`, `proof` JSON, `claimed`, `claim_tx` |
| `transcripts` | `req_id` PK/FK, `prompt`, `response`, `expires_at` (7 days; kept for future verification) |

Sessions use a signed JWT. They do not need a table.

Credit columns are integer millicredits (`*_mc`, 1 credit = 1000 mc). HBAR columns are tinybar decimal strings. Times are Unix ms. See `shared/README.md`.

---

## 9. Reliability reputation (MVP)

The reputation measures reliability only. It does not measure output quality in the MVP.

### 9.1 Score for each node

```
reliability = 0.7 × success_rate + 0.3 × uptime_rate      (0.0 to 1.0)
success_rate = successful_requests / requests_routed      (last 7 days)
uptime_rate  = heartbeats_received / heartbeats_expected  (last 7 days)
```

- A new node starts at 0.8.
- A failed request on the route counts as a failure for each node on the route. (In the MVP we do not find the stage that failed.)

### 9.2 Use of the score

| Use | Rule |
|---|---|
| Pool score | Pool reliability = the lowest node reliability in the pool. The router uses it (Section 5.4). |
| Display | The account page and Arkiv show the score. |
| Limit | No penalties in credits in the MVP. |

---

## 10. C6: Hedera — detailed role

Hedera is the **payment rail** and the **permanent record** of the network.

### 10.1 Accounts (testnet)

| Account | Purpose |
|---|---|
| Treasury | Receives x402 payments. Funds each epoch payout. |
| Gateway operator | Pays HCS fees. Has the submit key for the ledger topic. |
| Settler | Calls `postEpoch` on the payout contract. |
| Agent wallet | Used by the AI agent client to pay with x402. |
| Provider payout accounts | One for each provider (ECDSA key, EVM address). Calls `claim`. |

### 10.2 HCS: the ledger topic

- One topic: `gpupool-ledger`.
- Only the gateway can write (submit key). Anyone can read.
- One message for each ledger event. Size less than 1 KB.

```json
{"v":1,"type":"request_settled","req_id":"…","account":"acc_…","model":"Qwen/Qwen3-14B-FP8",
 "in":412,"out":256,"cost":490,
 "split":{"node_m4":220.5,"node_m5":99.2,"node_4060":121.3,"burn":24.5,"reserve":24.5},
 "pay":"credits","prompt_hash":"0x…","resp_hash":"0x…","ts":1793912345123,"sig":"0x…"}
```

- The gateway signs each event with its own key. HCS adds the consensus timestamp and the sequence number.
- The receipt page shows the HCS sequence number and a HashScan link.
- The gateway writes to HCS asynchronously. The user does not wait for HCS.

### 10.3 x402

- Payments settle on Hedera testnet through the facilitator (Section 7).
- The README must show the transaction ID of a settled payment (track requirement).

### 10.4 Payout addresses

- A provider adds a payout address when the provider registers a node.
- The payout address is a Hedera account with an EVM address (ECDSA key).
- The gateway stores the link: account → payout address. The gateway writes a `payout_address_set` event to HCS.
- The node registry stays in Arkiv (Section 11). The contract does not need a node registry. It only needs the payout address and the amount.

### 10.5 HBAR payouts and the payout contract

**Epoch:** 10 minutes for the demo. 1 day after the demo.

**Division of x402 income in each epoch:**

| Part | Share |
|---|---|
| Providers | 80% |
| Network reserve (stays in treasury) | 10% |
| Operations (stays in treasury) | 10% |

The provider share of each x402 request is divided by layers served, with the same rule as credits (Section 8.3). The self-request rule also applies: a share for a node that the payer owns stays in the treasury. If the route of the request is unknown (Section 5.5), its provider share stays in the treasury.

**Epoch close (gateway settlement job):**

1. Select all x402 requests of the epoch.
2. Calculate the amount for each payout address.
3. Make a Merkle tree. Each leaf is `(payout_address, amount_tinybar)`.
4. Write the full list as an `epoch_closed` event to HCS (if the list is large, write its hash and keep the list in the gateway).
5. Call `postEpoch(epoch, root)` on the contract. Send `total` HBAR from the treasury with the call (`msg.value = total`, in tinybars inside the EVM).
6. After the claim delay, each provider calls `claim(epoch, amount, proof)` from the frontend.

**Contract: `EpochPayout.sol` (Hedera EVM, testnet)**

```solidity
// Minimal MVP contract. No vesting, no disputes, no node registry.
contract EpochPayout {
    address public settler;                 // gateway settlement key
    uint64  public claimDelay;              // seconds; 0-300 for the demo
    struct Epoch { bytes32 root; uint256 total; uint256 claimed; uint64 postedAt; }
    mapping(uint64 => Epoch) public epochs;
    mapping(uint64 => mapping(address => bool)) public hasClaimed;

    function postEpoch(uint64 epoch, bytes32 root) external payable;   // only settler; msg.value = total
    function claim(uint64 epoch, uint256 amount, bytes32[] calldata proof) external;
        // leaf = keccak256(abi.encodePacked(msg.sender, amount)); pays msg.sender
    function sweep(uint64 epoch) external;   // only settler; returns unclaimed HBAR after sweepDelay (constructor, default 7 days)

    event EpochPosted(uint64 indexed epoch, bytes32 root, uint256 total);
    event Claimed(uint64 indexed epoch, address indexed account, uint256 amount);
}
```

**Rules:**
- Only the settler can post an epoch.
- An address can claim only once for each epoch.
- A claim needs a valid Merkle proof.
- Use a reentrancy guard on `claim`.

**Hedera notes:**
- Inside the EVM, `msg.value` is in **tinybars** (8 decimals). JSON-RPC tools show **weibars** (18 decimals). Write a test for the units.
- Deploy through the Hashio JSON-RPC relay (`https://testnet.hashio.io/api`, chain ID 296). Verify the contract on HashScan.
- Use HBAR only. No HTS token association is necessary.

**Trust in the MVP:** the contract trusts the settler for the Merkle root. Anyone can compare the root with the HCS records. A challenge window and disputes are post-MVP.

### 10.6 What Hedera does NOT do in the MVP

- No node registry contract (Arkiv does this).
- No vesting or clawback.
- No dispute or challenge process.
- No USDC.

---

## 11. C7: Arkiv — detailed role

Arkiv is the **public directory** of the network. It shows what exists **now**. Each record has an owner and an expiry.

### 11.1 Network and SDK

- Testnet: Rabdi (chain ID 7794095), RPC `https://rpc.rabdi.db-chain.testnet.arkiv.network`.
- SDK: `@arkiv-network/sdk` with `viem` (TypeScript). The node agent can call a small TypeScript helper, or use JSON-RPC from Python.

### 11.2 Entities

| Entity | Writer | Fields (indexed fields in bold) | Expiry | Reader |
|---|---|---|---|---|
| `gpupool.node` | Node agent (node key) | **owner_account**, **node_id**, **pool_id**, **gpu**, mem_gb, **status**, layers, tok_s, reliability | 120 s, extended every 30 s | Frontend network page, gateway |
| `gpupool.pool` | Coordinator (pool key) | **pool_id**, **models**, members, **status**, coordinator_url_hash, layer_map | 120 s, extended every 30 s | **Router**, model list, frontend |
| `gpupool.model` | Admin | **model_id**, mlx_variant, size_gb, model_factor, license | 30 days | Gateway, frontend |
| `gpupool.account_stats` | Gateway | **account_id** (pseudonymous), earned, spent, ratio, reliability | 1 day, updated every 10 min | Frontend leaderboard |

### 11.3 Why Arkiv

- **Liveness.** A node that stops cannot extend its listing. The listing disappears automatically. No cleanup code is necessary.
- **Owner-signed.** Each node writes its own listing with its own key. The operator cannot show capacity that does not exist.
- **Read path.** The router reads pool listings to select a pool. The model list in the frontend comes from Arkiv. This is a real read path (track requirement).

### 11.4 Write rate

- Arkiv blocks are about 2 seconds. Do not write for each request.
- Nodes and pools write every 30 seconds. Account stats write every 10 minutes.

### 11.5 Track files

The repository must have `/arkiv/schema.md`, `/arkiv/friction.md`, `/arkiv/reach.md`, `/arkiv/why-arkiv.md`, and `/arkiv/how-you-use-arkiv.md`. The README must show the writer wallet addresses and one query that runs.

---

## 12. C8: Frontend (Next.js)

| Page | Content | Data source |
|---|---|---|
| `/` Login | World ID login (IDKit widget) | Gateway |
| `/chat` Playground | Model list, chat, route (node and layers), cost, new balance, HCS link | Gateway, Arkiv |
| `/account` | Balance (starter, earned), ratio, my nodes, reliability, recent receipts | Gateway |
| `/network` | Pools and nodes, live status, reliability | Arkiv |
| `/ledger` | Recent ledger events with HashScan links | Gateway, Hedera mirror node |
| `/payouts` | Epoch payouts: my claimable HBAR, Claim button, past claims | Gateway (proofs), payout contract |

Rules:
- Show the data source on each list ("Arkiv", "HCS #seq").
- Never put a private key or the World signing key in `NEXT_PUBLIC_*`.

---

## 13. C9: AI agent client

- A TypeScript script on the requester laptop.
- It asks 5 questions to the gateway. It pays each request with x402 automatically.
- It has a budget limit. It stops when the limit is reached.
- It prints the HashScan link for each payment.

---

## 14. Data the MVP keeps for later verification

The MVP has no output verification. To not design against it, the gateway keeps:

- `prompt_hash` and `resp_hash` in each receipt and HCS event.
- The full prompt and response for 7 days in a local store (for future sampling).
- The route and layer map for each request.
- The model and settings (temperature, seed if given).

---

## 15. Security (MVP minimum)

- The Parallax API stays on `127.0.0.1`. The gateway is the only public service.
- Each node uses a private network name, fixed ports, and firewall rules for pool member IPs only.
- Secrets (Hedera keys, World signing key, gateway signing key, Arkiv keys) stay in `.env` files that Git ignores.
- SSH (if used) accepts keys only. Password login is off.

---

## 16. Out of scope for the MVP (to build after the MVP)

### 16.1 Inference and pools

| Item | Notes |
|---|---|
| Fault tolerance | Gateway failover when a node stops during a request (resend prompt + partial answer to another pool). |
| Stall detection | Detect a stall of more than 5 s in the stream and find the stage that stalled. |
| Node join and leave while the pool runs | Rebalance, spare copies, cool-down before global rebalance. |
| Heartbeat grace hook | Launcher patch so that a node that waits more than 30 s is not dropped. Removes synchronized joins. |
| Ghost guard and admission hook | Reject heartbeat-only joins and unknown peers inside the Parallax scheduler. |
| Clean restart after reassignment | Coordinator restarts members after a re-placement. |
| Network address change | Node agent restarts Parallax when its IP changes. |
| Automatic pool formation | Nodes with delay less than 5 ms form a pool automatically. |
| Many pools and coordinator election | Elect the most reliable node; replace a coordinator that stops. |
| Exact route for each request | Capture `routing_table` from the scheduler for each request. |
| Coordinator cross-check | Compare the coordinator report with node reports (`--notify-url`). |
| WAN / Global Host | Pools over the internet, relay servers. |
| Memory-aware scheduling | Keep about 1 GB free on 16 GB Macs; budget for the OS. |
| Speculative decoding, batching tuning | Speed improvements. |
| Privacy | Keep the first layers on trusted nodes; encryption. |

### 16.2 Verification

| Item | Notes |
|---|---|
| Output verification | Canaries and sampled re-checks with Token-DiFR on idle pools. |
| Verifier selection and appeals | Different owners, second verifier, reference node, appeal window. |
| Capability challenge | Random input with a time limit to detect fake hardware claims. |
| Group testing | Find the bad node across different routes. |

### 16.3 Incentives and reputation

| Item | Notes |
|---|---|
| Vesting of earned credits | Earned credits unlock after N epochs; can be taken back for fraud. |
| Fraud penalties and bans | Loss of unvested credits; ban on the World nullifier. |
| Stage-level blame | Only the stalled stage loses credits for a failed part. |
| Expiry of earned credits | Prevents hoarding. |
| Collusion detection | Flag repeated flows between the same accounts and pools. |
| Reputation-based node cap | 1 → 3 → 5 nodes as reliability and history grow. |
| Passport credential tier | Optional stronger World credential. |
| World Agent Pass | Human-backed agents (if it fits). |
| Routing preferences and pool pinning | Own pools and private pools; region, latency, reputation preferences. |
| Availability rewards | Small credits for standby capacity when the pool needs it. |

### 16.4 Hedera and Arkiv

| Item | Notes |
|---|---|
| Contract extensions | Vesting and clawback, challenge window and disputes, on-chain checks of the settler. |
| Legal check for real-money payouts | Needed before mainnet. The MVP uses testnet HBAR only. |
| USDC payments | HTS token association. |
| Scheduled Transactions | Automatic epoch settlement. |
| ERC-8004 | Register the gateway as one agent. |
| Swarm bundles | Full receipt bundle for each epoch on Swarm (Arkiv bonus). |
| Multiple gateways | Independent gateways that share HCS and Arkiv state. |
| Postgres | Replace SQLite when more than one gateway runs or traffic grows. |

---

## 17. Build order

| Step | Work | Done when |
|---|---|---|
| 1 | Pool runner scripts; 3-node pool with M5 added | Warm-up request works through `127.0.0.1:3001` |
| 2 | Gateway skeleton: proxy `/v1/chat/completions` to the pool | Request from the requester laptop works |
| 3 | World login + accounts + starter credits | Login works; second account is rejected |
| 4 | Credit ledger: hold, settle, split, receipts | Balances change correctly |
| 5 | HCS topic + event writer | Events appear on HashScan |
| 6 | Arkiv: node agent listings, pool listing, model list, router reads Arkiv | Model list comes from Arkiv; stopped node disappears |
| 7 | x402 + AI agent client | Agent pays and gets answers; transaction ID in README |
| 7b | Payout contract + settlement job + claim page | Epoch posts on HashScan; a provider claims HBAR |
| 8 | Reliability score + priority queue | Scores show on the account page |
| 9 | Frontend pages | Full demo runs |
| 10 | Track files, README, demo video | Ready to submit |
