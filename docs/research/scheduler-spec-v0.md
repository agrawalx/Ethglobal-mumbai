# Campus GPU Pool: Scheduler Specification (v0.1)

Status: draft for team decision. Companion to `campus-gpu-pool-build-plan.md` and `campus-gpu-pool-research-notes.md`.

---

## 1. Product: what's missing in the market

We are building a **marketplace where anyone can host their laptop**, and the pool serves models that no single member could run. The nearest competitor is **Darkbloom** (Eigen Labs).

| | Darkbloom (from its docs, Nov 2026) | Campus GPU Pool |
|---|---|---|
| Hardware | **Apple Silicon only** | Any machine with a GPU: NVIDIA (CUDA), Apple (Metal), AMD/Intel (Vulkan); CPU nodes for light work |
| Minimum to earn | **16 GB to install, 36 GB to serve any model** | Any node with roughly 4 GB or more of usable GPU memory can serve something |
| Largest model | Bounded by the **biggest single Mac**. The docs don't describe splitting a model across nodes | Bounded by the **whole pool's memory**, because models are split across nodes |
| Catalog | About 5 fixed models, each with a RAM floor | Any GGUF model in the catalog that fits the pool |
| Verification | Attested, hardened provider process | Statistical: canaries, re-execution, reputation, stake (see §8) |
| **Privacy** | **Strong**: requests encrypted to the provider, coordinator in a confidential VM | **Weaker.** In a split model, the first node can recover the prompt. Roadmap item; **don't claim parity** |
| Main problem seen | A review reports about **$0.60/day** earnings: too little demand | Same risk. Demand is a marketplace and pricing problem, **not** something the scheduler can fix |

**Pitch:** "Darkbloom shuts out 16 GB Macs and every gaming laptop. We pool them, so a 16 GB Mac plus an 8 GB gaming laptop together can serve a model neither could run alone."

---

## 2. Requirements

| # | Requirement | Meaning |
|---|---|---|
| R1 | **Generic** | Any number of nodes and models, any mix of hardware. No hardcoded machine counts |
| R2 | **Fault tolerant** | A node leaving should cause a short pause in a reply, not a failed request |
| R3 | **Multiple users at once** | One copy of a model serves several users at the same time |
| R4 | **No idle pool** | Spare capacity is always doing something useful |
| R5 | **Verification built in** | Checking work is part of scheduling, not added on later |
| R6 | **Owner-friendly** | Owners can pause any time. The scheduler drains their node's work gracefully |

Each requirement below is described in three parts:
- **Now:** on llama.cpp RPC
- **Later:** on the custom pipeline runtime (Phase 8)
- **Unverified:** what still needs testing

---

## 3. Core concepts

| Term | Definition |
|---|---|
| **Node** | One machine running the node agent |
| **Replica** | One running copy of one model that serves requests. Either a **single** node (capacity mode) or a **group** of nodes (split mode) |
| **Slot** | One concurrent conversation inside a replica. A replica has `n_slots` slots |
| **Plan** | The full assignment: replicas (model, members, layer split, slots), spares, and idle duties |
| **Backend** | The runtime a replica runs on: `rpc` now, `pipeline` later |

### Backend capability flags (this is what makes it generic)
`allocate()` reads these flags. It never checks which runtime it is by name.

| Flag | `rpc` (llama.cpp) | `pipeline` (custom, later) |
|---|---|---|
| `fixed_membership` | true: changing members means a restart | false: members can be swapped live |
| `restart_cost_s` | Measured (model load time; faster with `-c` cache) | Small: one stage reload |
| `supports_slots` | true (`-np N`, continuous batching) **[verify: T5]** | true |
| `supports_stage_replay` | false | true |
| `split_objective` | `sequential` → fastest-first | `pipelined` → water-filling |
| `exposes_stage_io` | false | true (needed for per-stage checks) |

---

## 4. Inputs

### Node (from the node agent: benchmark at registration, heartbeat every 2 s)
| Field | Source |
|---|---|
| `mem_usable_bytes` | Free VRAM or unified-memory limit, minus a safety margin |
| `read_gbps` | **Measured.** GB of weights read per second, from a llama-bench run (T1 showed this model is accurate to about 2%) |
| `backend_kind` | cuda / metal / vulkan / cpu |
| `disk_free_bytes` | For hosting model files |
| `rtt_ms[peer]`, `segment` | Network map |
| `uptime_score` | Rolling fraction of promised time the node was actually online (0–1) |
| `reputation` | From verification (§8) |
| `owner_policy` | Availability windows, plugged-in only, temperature cap, max slots, pause |
| `thermal_state` | Normal / throttling (lowers effective `read_gbps`) |

### Model (from the catalog)
`size_bytes`, `n_layers`, `kv_bytes_per_token`, `ctx_default`, `license`, `sha256`, `priority`, `min_replicas`

### Demand (from the gateway, rolling 5-minute window)
`req_rate[model]`, `active_slots[model]`, `queue_len[model]`, plus a count of requests waiting per priority class (§7)

---

## 5. Allocation (Phase 1: slow, runs on change)

**Runs on:** a node joining or leaving, a demand shift above a set threshold, a reputation change (quarantine), or periodically (e.g. every 5 min).

**Cool-down:** at most one reconfiguration per model per `cooldown_s`. The only exception is a model with **no live replica**.

### 5.1 Memory each replica needs
```
need(model, slots) = size_bytes + slots × ctx × kv_bytes_per_token + runtime_overhead
```
- In a group, the **KV cache is split across members** in proportion to their share of layers. Each member must fit its weights share plus its KV share plus overhead.
- Example: Qwen2.5-32B uses about 0.25 MB of KV cache per token. A 4k-token slot is about 1 GB, so 4 slots is about 4 GB on top of the ~19.9 GB of weights. **Compute this per model; don't assume it.**

### 5.2 Algorithm (greedy, generic)
```
for model in models sorted by (priority, unmet demand) desc:
    target_replicas = clamp(ceil(demand / capacity_per_replica), min_replicas, max)
    while replicas(model) < target_replicas:
        if fits on one free node (need ≤ mem_usable):
            pick the SMALLEST node that fits
                (best-fit: keeps big nodes free for big models)
        else:
            build_group(model)
                (see 5.3; if the free nodes can't fit it → stop, report "pool too small")

leftover nodes → idle duties (§7)
```

### 5.3 Building a group: speed and reliability together
A group is alive only if **every** member is alive, so its availability is the product:
`P(alive) = Π uptime_score(member)`. Three 0.9 nodes give only 0.73. Pure "pick the fastest nodes" ignores this, and it's the main issue for a laptop marketplace.

```
candidates = free nodes with reputation ≥ R_min and backend in the group-eligible set
             (not CPU)
score(node) = read_gbps × uptime_score^β        # β trades speed against reliability
add nodes by score until Σ mem_usable ≥ need
prefer: same segment, low RTT, fewer members (each extra member = 1 more hop
        and 1 more failure point)
reject the group if P(alive) < P_min → try a different set, else stop
```

### 5.4 Splitting layers inside a group
- `sequential` (RPC): **fastest-first**. Fill the fastest member's share up to its memory limit, then the next. This minimises time per token for each user.
- `pipelined` (later): **water-filling**. Balance the time each stage takes. This maximises total output with many users (from Parallax).
- Output is contiguous layer ranges; for RPC these become the `--tensor-split` values.
- **Host (RPC):** the fastest member with enough `disk_free` for the model file.
- **[verify: T3]** whether `--tensor-split` controls the split exactly when RPC devices are present.

### 5.5 Output: the Plan (pure function)
```ts
allocate(nodes, models, demand, prevPlan, backendCaps): Plan
diff(prevPlan, nextPlan): Action[]   // start / stop / reconfigure per node
```
- `allocate` has no side effects, so it can be tested on made-up clusters.
- `diff` keeps unchanged replicas running. It never restarts a healthy replica just to make the plan tidier.

---

## 6. Routing (Phase 2: fast, every request)

**Now:**
1. Candidates are live replicas of the requested model that are not draining.
2. Score each: `(active_slots + queue) / (n_slots × speed_factor)`, multiplied by a reputation weight. Lowest score wins.
3. **Session affinity:** later turns of the same conversation go to the same replica (its KV cache already holds the conversation).
4. If every slot is full, queue the request (bounded) or return `503 + Retry-After`.

**Later (pipeline):** Parallax's per-request path search over (layer, node) pairs, plus per-stage load. The interface stays `route(req, plan, load) → target`.

---

## 7. Utilisation: making sure the pool is never idle (R4)

### Priority tiers (higher tiers take capacity from lower ones)
| Tier | Work | Paid? |
|---|---|---|
| P0 | Interactive requests (x402 paid, or human free quota) | Full price |
| P1 | **Batch / async jobs** (submit now, collect later: embeddings, bulk summarising, evals) | Discounted (e.g. 50%) |
| P2 | **Verification work**: canaries, re-execution of sampled requests (§8) | Paid from the protocol fee |
| P3 | **Warm spares**: model loaded and ready to take over (§9) | Warm-pool points (from fees, capped; brief §5.2) |
| P4 | Pre-caching weights / RPC cache for likely future groups | Unpaid |

- Spare capacity is used in this order: P1 → P2 → P3 → P4.
- **Verification is useful idle work.** R4 and R5 reinforce each other.
- **Not a scheduler problem:** if nobody sends P0 or P1 work, the pool earns nothing however well it's scheduled. Demand comes from pricing, the agent market (x402) and campus users. Track `utilisation = busy slot-seconds / available slot-seconds` per node and show it to owners honestly.

### Multiple users at once (R3)
- **Now: batching inside a replica.** `llama-server -np N` gives N slots with continuous batching.
  - Generating a token is limited by how fast weights can be read from memory, so **a batch of 4 reads the weights once**.
  - Total output grows almost linearly until compute or KV memory runs out.
  - Over RPC, every stage processes the whole batch.
  - **[verify: T5]** that `-np` works with `--rpc`, and measure total tok/s at 1, 2, 4 and 8 slots.
- **Later: overlapping requests across stages.** While stage 2 works on user A's token, stage 1 works on user B's. This needs the `pipelined` backend.
- `n_slots` per replica is chosen in allocation (§5.1), limited by KV memory.

---

## 8. Verification built into scheduling (R5)

| Hook | Where | Rule |
|---|---|---|
| **Canaries** | Router | Inject canary prompts at rate `p_canary` through the **normal path**, so they look like real traffic. Score against references (logprob distance, or Token-DiFR; choose by the D6 calibration) |
| **Re-execution** | Allocator + router | Sample real requests at rate `p` (PoSP: `p > C/((1−r)(R+S))`). Re-run on an **idle replica** of the same model, from a **different owner**, preferably the same hardware class. Runs as P2 work |
| **Reputation → routing** | Router | Routing weight is multiplied by reputation. Below `R_route` → no P0 traffic |
| **Reputation → groups** | Allocator | Below `R_min` → not eligible to join groups (one cheater spoils the whole group) |
| **Quarantine** | Allocator | A failed check removes the node from all replicas immediately, reports the evidence to the contract (slash), and triggers re-allocation |
| **Per-stage checks** | Later (pipeline) | `exposes_stage_io` → hash stage input/output; a verifier re-runs one stage (Verde, applied per stage), or uses Activation-DiFR |

**Group nuance:** on RPC, a canary checks the **whole group**. A failure says "someone in this group cheated", not who. Narrow it down by re-running the canary with members swapped, or by testing each member in capacity mode. Per-stage blame needs the pipeline backend.

---

## 9. Fault tolerance (R2): three levels

| Level | Mechanism | Backend | User sees |
|---|---|---|---|
| **L1: Request failover** (build now) | The gateway keeps `prompt + tokens generated so far` for every in-flight request. On replica failure, it re-sends to another replica of the same model as a **continuation** (prompt + partial output). The new replica reads it all in at prefill speed (measured: ~2,600 tok/s on 7B) and keeps generating | Any | A pause of about 1–3 s, then the stream continues |
| **L2: Warm spares** | Keep ≥1 spare replica (or spare nodes with the RPC cache warm) per important model, so L1 has somewhere to go and the group can be rebuilt quickly | Any (P3 idle duty) | Same as L1, even when no other live replica exists |
| **L3: Stage replay** (later) | Petals-style: the coordinator logs each stage's inputs and replays them to a replacement node holding the same layers. Only the failed stage is swapped | `pipeline` | A short pause; the other stages keep their state |

**Notes:**
- With greedy decoding, the continuation is identical to an uninterrupted reply. With sampling, the text after the failure point may differ, which is fine.
- A failed group stays **down until rebuilt**. The rebuild time is `restart_cost_s`, minutes for a cold 32B load and much faster with a warm `-c` cache. This is why L2 matters on RPC.
- **Detection:** heartbeat timeout (e.g. 3 missed beats = 6 s), **or** the stream stalls for longer than `stall_s`, **or** an RPC error reported by the host.

### Owner pause and leave (R6)
- **Planned pause** (owner clicks pause, starts a game, unplugs the charger, or an availability window ends) → **drain**:
  1. Stop routing new requests to replicas containing the node.
  2. Let in-flight requests finish, up to `drain_timeout_s`.
  3. Fail over any that remain (L1).
  4. Release the node.
- **Sudden loss** (lid closed, crash) → L1 failover straight away.
- Both lower `uptime_score` **only** when the owner broke a promised availability window. Pausing outside promised hours is free. This keeps the marketplace fair to owners.

---

## 10. Metrics the scheduler must expose
- Per model: tok/s per user, total tok/s, p50/p95 time to first token, queue length, replicas, slots
- Per node: utilisation, uptime_score, reputation, thermal state, earnings
- Per group: P(alive), restarts, failovers
- Pool: unmet demand (requests waiting for models that are too big or have no replica)

---

## 11. Test plan (generic: synthetic clusters, not our 3 machines)
| Case | Expectation |
|---|---|
| 1 node, small model | One capacity replica |
| Our pool: 4060 + M5 + M4 + CPU node, 32B | 1 group of 3; the CPU node gets verifier/idle duty |
| 20 mixed nodes, 3 models, skewed demand | Replicas proportional to demand; best-fit keeps big nodes for big models |
| Model larger than the whole pool | Clean "pool too small", no partial plan |
| Flaky nodes (uptime 0.5) | Excluded from groups; used in capacity mode |
| Node leaves mid-stream | L1 failover; the stream continues |
| Cheater in a group | Group flagged → isolated → quarantined |
| Demand spike, then drop | Scale up after cool-down; scale down without killing in-flight requests |

---

## 12. Open decisions

| # | Decision | Default proposal |
|---|---|---|
| S1 | Default `n_slots` per replica | 4, capped by KV memory (§5.1). Confirm after T5 |
| S2 | Warm-spare policy | 1 spare per model with demand in the last hour; 0 otherwise |
| S3 | Batch tier (P1): offer it? Price? | Yes, 50% of interactive price, no latency guarantee |
| S4 | Group reliability floor `P_min` and weight `β` | P_min = 0.8, β = 2 (tune by simulation) |
| S5 | Reputation thresholds `R_route`, `R_min` | Set after calibration (D6) |
| S6 | Re-execution rate `p`, canary rate | From PoSP once prices and stake are set (D16) |
| S7 | `cooldown_s`, `drain_timeout_s`, `stall_s` | 300 s, 60 s, 5 s |

## 13. Tests to run before this spec is final
| Test | Question |
|---|---|
| T2 | Do RPC groups work across CUDA and Metal machines (4060 + M5 + M4)? Load time, tok/s |
| T3 | Does `--tensor-split` control the split exactly? |
| **T5** | Does `-np N` work over `--rpc`? Total tok/s at 1/2/4/8 slots; KV memory per slot |
| **T6** | L1 failover: kill a worker mid-stream → the gateway continues on another replica. Measure the pause |
| T7 | Restart cost: cold vs `-c` warm group load time for 14B and 32B |

---

## Sources
- Darkbloom docs: https://docs.darkbloom.dev/introduction
- Darkbloom provider overview: https://docs.darkbloom.dev/provider/overview
- Darkbloom earnings review: https://miyagadget.page/en/blog/2026/06/24/darkbloom-provider-mac-earnings-review-en/
- Darkbloom GitHub: https://github.com/darkbloomdev/darkbloom
- Parallax (allocation and routing design): https://arxiv.org/abs/2509.26182
- Petals (stage replay): https://arxiv.org/abs/2209.01188
- PoSP (check rate): https://arxiv.org/abs/2405.00295
- DiFR (verification scoring): https://arxiv.org/abs/2511.20621
