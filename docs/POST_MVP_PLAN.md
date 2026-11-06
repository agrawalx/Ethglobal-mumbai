# POST-MVP BUILD PLAN: Items Out of Scope for the MVP

**Status:** proposal only. Nothing in this file is approved scope. `docs/SPEC.md` §16 lists the
items; `CLAUDE.md` §2 still forbids building them during the hackathon MVP. Use this file after
the MVP ships, or to answer judges who ask "what is next".

**Inputs:** `docs/SPEC.md` §16, `docs/research/*.md`, our Parallax tests (5–6 Nov 2026), and the
web and paper research listed in §9 (searched 6 Nov 2026).

Writing standard: mostly ASD-STE100. One section for each item: **Problem → What research says →
Our approach → Build steps → Done when**. Effort: S ≤ 1 day, M ≤ 1 week, L > 1 week (1 developer).

---

## 0. Summary

### 0.1 Order of work

| Phase | Theme | Why this order | Items |
|---|---|---|---|
| **P5** | Serving resilience | Failed requests are the largest user-visible problem now. Parallax does not recover a request when a node fails during the request. | Stall detection, L1 failover, heartbeat grace hook, ghost guard, clean restart, IP change, memory-aware scheduling, exact route, coordinator cross-check |
| **P6** | Verification | Without it, a node can run a cheaper model and still earn. All later penalties need proof. | Token-DiFR canaries, check rate (PoSP), verifier selection and appeals, capability challenge, group testing, stage blame |
| **P7** | Incentives | Penalties need verification (P6) first. Do not take credits without evidence. | Vesting, earned-credit expiry, fraud penalties and bans, collusion detection, node cap, availability rewards, routing preferences, Passport tier, Agent Pass |
| **P8** | Hedera and Arkiv extensions | These make P7 enforceable on-chain and add payment options. | Contract v2 (vesting, clawback, challenge window), Scheduled Transactions, USDC, ERC-8004, Swarm bundles |
| **P9** | Scale-out | Needed only when there is more than one pool or gateway. | Automatic pool formation, many pools and coordinator election, multiple gateways and Postgres, WAN and relays, speculative decoding, privacy |
| **Legal** | Runs in parallel | Required before any mainnet payout. | Legal check for real-money payouts |

### 0.2 Foundation: the MVP stays as it is

This plan **extends** the MVP. It does not replace any MVP component or rule. Every item below
adds to an existing MVP part (gateway, node agent, `pool/` scripts, SQLite tables, HCS events,
Arkiv entities, `EpochPayout`). If an item needs to change an MVP rule, it is marked
**"SPEC change needed"** and needs approval first (`CLAUDE.md` §2.6).

These MVP decisions (`CLAUDE.md` §3, `docs/SPEC.md`) stay fixed in every phase:

| MVP decision | Stays as |
|---|---|
| Inference | Parallax as an installed dependency. Never forked. Wrappers and hooks only in `pool/`. |
| Gateway | One TypeScript service is the public entry point (P8.6 adds more of the **same** gateway). |
| Ledger | SQLite working copy + every balance change to HCS, written asynchronously. Requests never wait for HCS or Arkiv. |
| Identity | World IDKit, action `gpupool-account`, one account per nullifier. |
| Payments | Credits for accounts; x402 HBAR on Hedera for requests without a session. |
| Payouts | x402 income → HBAR per epoch via Merkle claim. |
| Directory | Arkiv for nodes, pools, models, account stats. Write rates of SPEC §11.4. |
| Router | Model → pool from Arkiv; score = reliability × (1 − load); Parallax picks nodes inside the pool. |
| Reputation | Reliability = 0.7 success + 0.3 uptime. |
| Incentives | Credit formula, 90/5/5 split, self-request rule, starter credits (SPEC §8). No new incentive rules unless SPEC §16 names them. |
| Data kept | `prompt_hash`, `resp_hash`, route, settings, 7-day transcripts (SPEC §14) — the base for P6. |

### 0.3 Rules for every post-MVP item

1. **Parallax stays an installed dependency.** "Patches" in this file are **runtime hooks** in
   `pool/` (a launcher wrapper that patches functions at import time, pinned to a Parallax
   commit). Each hook has a test that fails when the pinned Parallax version changes. Upstream PRs
   where possible.
2. **No penalty without evidence.** Every credit or HBAR penalty cites a verification record
   (P6) that anyone can check from HCS.
3. **Money logic gets tests** (vesting math, clawback, PoSP rate).
4. **No per-request Arkiv writes.** All new Arkiv entities follow SPEC §11.4 rates.
5. **Shared types first.** New API fields, HCS events and Arkiv entities go into `shared/` first,
   then all users (`CLAUDE.md` §4.2).
6. **New config keys** go to `.env.example` and `docs/HANDOFF.md` §8.

### 0.4 Which MVP part each item builds on

| Item | Builds on (MVP) | Type of change |
|---|---|---|
| P5.1 Stall detection | `gateway/src/chat.ts` SSE proxy | Extends |
| P5.2 L1 failover | `router.ts` pool score, `queue.ts`, SPEC §8.3 split | Extends |
| P5.3–P5.6 Hooks, restart, IP change | `pool/*.sh`, node agent | Extends |
| P5.7 Memory-aware | node agent heartbeat, known-good Mac flags | Extends |
| P5.8–P5.9 Exact route, cross-check | `requests.route`, signed node heartbeats | Extends |
| P6.x Verification | SPEC §14 data (hashes, transcripts, route) | New service, reads MVP data |
| P7.x Incentives | SPEC §8 ledger, `balances`, `node_reliability`, World nullifier | Extends (P7.1–P7.3 SPEC change needed) |
| P8.1–P8.2 Contract v2, scheduled tx | `EpochPayout.sol`, settlement worker | New version of the same flow |
| P8.3 USDC | x402 path in the gateway | Second asset on the same path |
| P8.4–P8.5 ERC-8004, Swarm | gateway identity, `epoch_closed` HCS event | Adds references |
| P8.6–P8.7 Multi-gateway, Postgres | SQLite + HCS ledger | Same model, more instances |
| P9.x Scale-out | Arkiv `gpupool.pool`, router, coordinator in node agent | Extends

### 0.5 Corrections to our earlier research notes

| Where | Old text | Correct text (source) |
|---|---|---|
| `research-notes.md` Problem 11 | `p > C / ((1 − r)(R + S))` | `p > C / ((1 − r)·S + (1 − 2r)·R)`, with n = 1 validator. With r = 0.1, S = 150C, R = 1.2C: p ≈ 0.736%. ([PoSP v3, Prop. 1](https://arxiv.org/html/2405.00295v3)) |
| `research-notes.md` Problem 13 | "Option 3 (logprob tolerance) is the most realistic" | Still true. There is now a published method for it: **Token-DiFR** (2025, ICML 2026). See P6.1. |

---

## P5. Serving resilience

**Status (6 Nov 2026): P5.1–P5.9 implemented on branch `backendXoutofscope`; tested locally, not yet
on the live 3-node pool.** Where: gateway `src/stall.ts`, `src/chat.ts`, `src/billing.ts`,
`src/pools.ts`; `pool/hooks/`, `pool/restart.sh`; node agent `notify.py`, `system.py`, `agent.py`.
Spec: SPEC §3.4, §4.3, §5.3 step 12, §5.4, §5.5. Differences from the text below:
P5.1 stall stage = route nodes with a late heartbeat (no node-agent `/local-status` endpoint);
P5.4 allow-list is written by the gateway (it shares the host with the scheduler), and node peer IDs
come from a node-side hook file because Parallax nodes get a new peer ID at each start;
P5.5 the gateway detects the live re-placement from heartbeats and orders the restart (no scheduler
watcher in the coordinator agent); P5.7 Parallax memory flags are enforced on Macs instead of a new
memory flag; P5.9 compares counts per node over a window (no request-ID mapping) and only flags.

### P5.1 Stall detection (> 5 s in the stream)

**Problem.** Parallax finds a dead node only by a 30 s heartbeat timeout. A broken stream can hang
for up to 180 s (forwarding timeout seen in our tests).

**Research.**
- Gateway products use an **inter-chunk read timeout** as the stall trigger, and record a request
  outcome of `success / partial_failed / partial_recovered`. A 200 status alone does not mean that
  the stream completed ([api7/aisix #882](https://github.com/api7/aisix/pull/882)).
- Normal time between tokens is predictable for one pool. Our measurements: 4060 alone about
  135 tok/s (0.6B); Mac pipeline about 7.9 tok/s (8B) → about 130 ms between tokens.

**Our approach.** Adaptive timeout for each pool:
`stall_ms = max(5000, 10 × p95_inter_token_ms)` for decode, and a separate time-to-first-token
limit from the prompt length (`ttft_limit = base + prefill_ms_per_token × input_tokens`).

**Build steps.**
1. `gateway/src/stall.ts`: wrap the Parallax SSE reader. Record the time of each chunk. Abort the
   upstream fetch on stall.
2. Keep a rolling p95 of time between tokens per pool in memory (no DB).
3. On a stall, ask each member's node agent for `/local-status` (new node-agent endpoint: last
   forward timestamp, layer range). The member with the oldest "last forward" timestamp is the
   **suspected stage**. Record it in `requests.stall_stage` (used by P6.6 and P7.4).
4. Hand over to P5.2.

**Done when.** A test with a fake Parallax that stops sending after 20 tokens ends the upstream
within `stall_ms` + 1 s, and the request row shows `partial_failed` and the suspected stage.
Effort: **S**.

### P5.2 L1 failover (resend prompt + partial answer)

**Problem.** A node that leaves during a request loses its KV cache. Parallax retries only before
forwarding starts.

**Research.**
- **Petals** (client-side replay): the client keeps every input it sent to each server. On
  failure it routes again and sends **all previous inputs** to the replacement, which rebuilds the
  same attention cache. Outputs matched the run without a failure
  ([Petals PR #91](https://github.com/bigscience-workshop/petals/pull/91),
  [arXiv 2209.01188](https://arxiv.org/abs/2209.01188),
  [NeurIPS 2023, arXiv 2312.08361](https://arxiv.org/abs/2312.08361)).
- **SpotServe** (ASPLOS'24): stateful recovery at token granularity plus a migration plan found by
  bipartite matching (Kuhn–Munkres); P99 latency 2.4–9.1× better
  ([arXiv 2311.15566](https://arxiv.org/abs/2311.15566)).
- **KevlarFlow** (2026): copies intermediate state to other nodes while it serves, so a partly
  served request continues on a live node ([arXiv 2601.22438](https://arxiv.org/html/2601.22438v1)).
- Client-side pattern: continue with the prior context in the prompt instead of starting again
  ([Atlassian Forge LLM errors](https://developer.atlassian.com/platform/forge/runtime-reference/forge-llms-api-errors/),
  [ExLLM StreamRecovery](https://hexdocs.pm/ex_llm/0.5.0/ExLLM.StreamRecovery.html)).

**Our approach.** We cannot do Petals-style replay at the stage level without forking Parallax.
Do it at the **gateway level** (L1):
1. Keep the tokens already streamed to the user.
2. Build a continuation request: the original messages + an assistant message with the partial
   answer, and `continue_final_message`-style templating (no new user turn) so the model goes on
   from the last token. SGLang supports prefix continuation through the raw `/generate` API; if
   the Parallax OpenAI endpoint does not support it, send the chat template rendered as raw text.
3. Send it to the **next best pool** for the same model (router score), or to the same pool after
   P5.5 restarts it.
4. Continue the same SSE stream to the user. Send a comment line (`: failover`) so the client can
   show a short pause.

**Billing (same MVP rules).** The requester pays the SPEC §8.1 cost **once**, for the total
tokens of the final answer. Each attempt's part of the cost is split with the SPEC §8.3 rule
(90/5/5 by layers, self-request rule) over that attempt's route. x402 stays as in the MVP: paid
before inference, no refund. Until P7.4 exists, a failed attempt's route gets a failure outcome
for every node (MVP rule SPEC §9.1).

**Build steps.** `gateway/src/failover.ts`; extend `requests` with `attempts` JSON (pool, tokens,
outcome). Test with two fake pools where the first one stalls.

**Done when.** With two pools, killing one Mac during a reply gives the user one continuous answer
with a pause of ≤ 3 s plus prefill time, and the receipt lists both attempts. Effort: **M**.

### P5.3 Heartbeat grace hook (no more synchronized joins)

**Problem.** Parallax sets the join timestamp once. A node that waits more than 30 s for
placement is dropped. We must start all joins within 30 s.

**Research.** Our source reading (commit `162354a`): the scheduler refreshes the timestamp only
when heartbeats arrive, and a node sends heartbeats only after it gets its layers. Parallax
release v0.1.1 fixed "slow reporting of node leave" and "node duplication during leftover node
allocation", but not this
([Parallax releases](https://github.com/GradientHQ/parallax/releases)).

**Our approach.** A runtime hook in `pool/hooks/grace.py`: when placement runs, refresh the
`last_heartbeat` of every node still waiting for layers, or skip the timeout check for nodes in
the "waiting for assignment" state. Load it with `PYTHONSTARTUP`-style import in the launcher
wrapper (`pool/start-scheduler.sh` calls `python -m gpupool_hooks.launch`, which patches and then
calls the Parallax entry point).

**Done when.** A node that joins 90 s after the others gets layers and serves. A hook test fails
if the patched function signature changes. Effort: **S**. Also open an upstream issue/PR.

### P5.4 Ghost guard and admission hook

**Problem.** Leftover child processes join again as "ghost" nodes with no hardware info. Any peer
that knows the DHT prefix can try to join.

**Our approach.** Scheduler hook that rejects a join when:
1. the join has no hardware details (heartbeat-only), or
2. the peer ID is not in an allow-list. The allow-list is the set of node keys that are
   registered with the gateway and have a fresh signed heartbeat. The coordinator's node agent
   writes it to a local file every 10 s; the hook reads it.

Node agent: sign the Parallax peer ID with the node key at registration, so the gateway can map
peer ID ↔ node ID.

**Done when.** A process without registration cannot join (log line `admission rejected`), and
`pool/stop-all.sh` + restart leaves no ghost. Effort: **S–M**.

### P5.5 Clean restart after reassignment

**Problem.** After a re-placement, a member handed over to a stale peer and requests hung until
we restarted both sides.

**Our approach.** The coordinator's node agent watches the scheduler for a placement change. On a
change: (1) the gateway marks the pool `restarting` (router skips it), (2) the coordinator asks
each member agent to stop its process group and join again (weights already on disk,
`HF_HUB_OFFLINE=1`), (3) warm-up request, (4) the pool returns to `ready`. Add a **cool-down**
(e.g. 120 s) before a global rebalance, so that a node that comes back fast does not cause a full
reload.

**Done when.** Unplug and replug one Mac: the pool is back to `ready` without manual commands, and
no request hangs. Effort: **M**.

### P5.6 Network address change

**Problem.** Parallax uses `--announce-maddrs` with a fixed IP. Venue Wi-Fi/DHCP changes it.

**Our approach.** Node agent polls the interface IP every 10 s. On a change: stop the process
group, rewrite `LAN_IP`, join again, send an `ip_changed` heartbeat field so the coordinator
updates firewall allow-lists (printed for the operator; firewall changes still need a human with
sudo).

**Done when.** Changing the Mac's IP gives a working node within 60 s. Effort: **S**.

### P5.7 Memory-aware scheduling (16 GB Macs)

**Problem.** Parallax plans for all the memory that the Mac reports. macOS and other apps then
push the Mac into swap or out-of-memory.

**Research.** MLX exposes `max_recommended_working_set_size` and a settable wired limit
(`iogpu.wired_limit_mb`, macOS 15+, resets at reboot). Guides suggest about 90% of RAM as a
ceiling, and say: shorten the context or quantize the KV cache before raising limits
([MLX memory.cpp](https://docs.rs/crate/mlxrs-sys/latest/source/vendor/mlx/python/src/memory.cpp),
[memory pressure guide](https://localaimaster.com/blog/mac-memory-pressure-local-llm)).

**Our approach.** The node agent reports `usable_mem_gb = min(recommended_working_set,
total − os_budget)` with `os_budget = max(4 GB, 25% of RAM)` on Macs, and passes it to Parallax
through the existing memory flags. Keep `--kv-cache-memory-fraction 0.25 --max-sequence-length
4096`. Watch `memory_pressure` / swap use in the heartbeat; mark the node `degraded` (router
skips the pool) if swap grows during serving.

**Done when.** A 16 GB Mac serves for 1 hour with a browser open and no swap growth. Effort: **S**.

### P5.8 Exact route for each request

**Problem.** The MVP takes the route from heartbeat layer maps. With spare copies, the real
route can differ.

**Our approach.** Hook in the scheduler request handler: after it picks the pipeline, write
`{request_id → [peer_id, start, end]}` to a local append-only file (or return it in a response
header if the endpoint allows). The gateway reads it by request ID and stores it in
`requests.route`. Fall back to the heartbeat map and set `route_source = "heartbeat"`.

**Done when.** With 2 pipelines, receipts show the pipeline that really served each request.
Effort: **S**.

### P5.9 Coordinator cross-check

**Problem.** The gateway trusts one coordinator for the route. A dishonest coordinator can credit
its owner's nodes.

**Our approach.** Each node agent counts the forward passes and tokens it served per request ID
(from the Parallax `--notify-url` callback or the node's log) and signs a short report every 10 s.
The gateway compares node reports with the coordinator route. A mismatch over a threshold (e.g.
> 2% of requests in an hour) sets a `route_dispute` flag and holds the credits for that pool
(needs P7.1 vesting).

**Done when.** A test coordinator that adds a fake node to routes is flagged within one hour.
Effort: **M**.

---

## P6. Verification

### P6.1 Output verification: canaries + sampled re-checks with Token-DiFR

**Problem.** A node can run a smaller or more compressed model and still earn. Hash comparison
does not work across our GPUs (CUDA 4060 vs MLX on Macs): floating-point order differs.

**Research.**
- **Token-DiFR** (Karvonen et al., 2025; ICML 2026): with a **shared sampling seed**, a trusted
  reference recomputes the sampling for the tokens the provider produced and measures the
  divergence. It detects 4-bit quantization with **AUC > 0.999 within 300 output tokens**. At
  temperature 0 it needs no help from the provider. **Activation-DiFR** uses random projections of
  activations and needs only 2 tokens, but needs provider help. Open-source vLLM integration
  ([arXiv 2511.20621](https://arxiv.org/abs/2511.20621), [ICML 2026](https://icml.cc/virtual/2026/78608)).
- **TOPLOC** (Prime Intellect, ICML 2025): hashes top-k activation values as a polynomial
  congruence; 258 bytes per 32 tokens; checks up to 100× faster than generation; claims to work
  across GPU types ([arXiv 2501.16007](https://arxiv.org/abs/2501.16007)). Needs a hook inside the
  model (activation access) → hard without forking Parallax.
- **LOGIC** (Inference.net, 2025): log-probability statistical tests over many heterogeneous GPUs
  ([blog](https://inference.net/blog/logic/)).
- **Deterministic inference** in SGLang (`--enable-deterministic-inference`, batch-invariant
  kernels) gives the same output for the same input, but about 2× slower and only on the same
  hardware type ([LMSYS](https://lmsys.org/blog/2025-09-22-sglang-deterministic/),
  [SGLang docs](https://docs.sglang.io/advanced_features/deterministic_inference.html)).
  **LLM-42** argues for verify-and-replay instead of batch invariance
  ([arXiv 2601.17768](https://www.arxiv.org/pdf/2601.17768)).

**Our approach: Token-DiFR, because it needs only the output tokens and the seed.**
1. **Canaries.** Fixed prompts with known outputs, sent at temperature 0 as normal x402-looking
   requests from a gateway-owned payer (the pool cannot tell them apart). Compare tokens with the
   stored reference.
2. **Sampled re-checks.** For a fraction `p` of real requests (P6.2), the gateway takes the stored
   transcript (SPEC §14 already keeps 7 days), the seed and the settings, and runs Token-DiFR on a
   **reference node**. The reference node is the gateway host's own GPU or an idle trusted pool,
   running the **same weights and quantization** in SGLang/vLLM with logprobs on. (The rule
   "never send `logprobs` to Parallax" stays: the reference is not the Parallax pool.)
3. **Calibration.** Run the honest pool against the reference for each hardware mix (CUDA-only,
   MLX-only, mixed) and record the distribution of the divergence score. Set the threshold at a
   false-positive rate ≤ 10⁻⁴ per request. Re-calibrate when a model or backend version changes.
4. **Seed.** The gateway sets `seed` on every request, and stores it. Check that Parallax/SGLang
   honours `seed` across a pipeline; if not, use temperature-0 canaries only until it does.

**Build steps.** `verifier/` service (Python, reuses the DiFR vLLM integration); queue of sampled
request IDs in SQLite; result table `verifications(req_id, pool_id, score, threshold, verdict,
reference_hash, ts)`; HCS event `verification_result`.

**Done when.** On a test pool where one node runs a 4-bit model instead of FP8, the verifier flags
it within 300 sampled tokens, and honest pools have no flag in 10,000 requests. Effort: **L**.

### P6.2 Check rate from Proof of Sampling

**Research.** PoSP (Hyperbolic): honesty is the unique pure-strategy Nash equilibrium when
`p > C / ((1 − r)·S + (1 − 2r)·R)` (n = 1 validator). Larger slash amounts allow a lower
check rate. Hyperbolic raises `p` for new nodes and lowers it for nodes with a long good record
([arXiv 2405.00295v3](https://arxiv.org/html/2405.00295v3),
[Hyperbolic blog](https://hyperbolic.ai/blog/deep-dive-into-hyperbolic-proof-of-sampling)).

**Our approach.** We have no stake. The "slash" `S` is the **unvested earnings** that the node
loses (P7.1–P7.3). Per pool and epoch:
```
C = verifier cost of one check (credits)
R = credits the pool earns per request
S = unvested credits of the pool's owners at risk
r = 0.1 (assumed dishonest share)
p = clamp( 1.5 × C / ((1 − r)·S + (1 − 2r)·R), p_min = 0.005, p_max = 0.2 )
```
New nodes (< 7 days or < 500 requests) use `p_max`. Unit tests for the formula.

**Done when.** The sampler reports `p` per pool, and the rate falls as vested history grows.
Effort: **S**.

### P6.3 Verifier selection and appeals

**Problem.** The verifier can lie or be wrong; nodes must be able to contest.

**Research.** PoSP and Verde both assume **at least one honest party** and use a second check on
a mismatch. Verde (Gensyn) finds the first step where two runs differ and re-runs only that step
([arXiv 2502.19405](https://arxiv.org/abs/2502.19405)). UMA's optimistic distributor uses a
**liveness (challenge) window**, 2 h by default, longer for more money
([UMA docs](https://docs.uma.xyz/developers/setting-custom-bond-and-liveness-parameters)).

**Our approach.**
1. The verifier must have a different owner (account) from every node on the route.
2. A flag opens an **appeal window** (24 h). The flagged owner can request a second check on the
   **reference node** run by the gateway operator (deterministic mode, same hardware class).
3. Final verdict = reference node result. All three results go to HCS.
4. Penalties (P7.3) apply only after the window closes.

**Done when.** A flagged node can appeal from the account page, and the HCS log shows check →
appeal → final verdict. Effort: **M**.

### P6.4 Capability challenge (fake hardware claims)

**Problem.** A node can claim a GPU it does not have, to get more layers or a better score.

**Research.**
- Timing and memory-hard challenges (dense matrix work, memory-hard functions, verifiable delay
  functions) produce timing tied to real GPU activity, with no trusted hardware
  ([arXiv 2602.09369](https://www.arxiv.org/pdf/2602.09369)).
- io.net uses an hourly PoW check to remove spoofed devices
  ([io.net docs](https://docs.io.net/docs/proof-of-work)).
- Caution: classifier-based detection can be evaded (detection fell to 43% under white-box
  evasion), so the verifier must be inspectable
  ([GreaterWrong](https://www.greaterwrong.com/posts/Jqb8Ev6hRgPqX8fGa/whitebox-evasion-is-the-baseline-for-gpu-workload)).

**Our approach.** At registration and then at random times (≤ 1 per hour, only when the pool is
idle): the gateway sends a random seed. The node agent runs a fixed benchmark: a matrix multiply
of size that fits the claimed memory, plus a **memory-fill test** (allocate and checksum the
claimed free VRAM / unified memory). It returns the checksum within a time limit. The gateway
checks the checksum (cheap: a random sub-block) and compares the time with the expected range for
the claimed GPU (a table from our own measurements: 4060, M4, M5). Out of range → node
`unverified_hardware`; the router does not use it.

**Done when.** A node that claims 24 GB on a 16 GB machine fails; real nodes pass 100 times in a
row. Effort: **M**.

### P6.5 Group testing (find the bad node across routes)

**Problem.** A failed check says "this route was wrong", not which node.

**Research.** Group testing finds defective items with few tests; probabilistic group testing
handles noisy workers with `O(L·log(n)/α)` tests
([Jain et al. 2023](https://ar5iv.arxiv.org/html/2305.06526));
group testing combined with compare-based verification localizes bad workers in coded computing
([arXiv 2607.02187](https://arxiv.org/pdf/2607.02187)).

**Our approach.** Each verification result is a test on the **set of nodes on that route**. When
spare copies exist, the gateway steers some canaries to routes that split a suspect set in half
(adaptive binary splitting). Keep a per-node posterior "bad" probability (Bayesian update from
each test). Above 0.95 → the node is flagged; the owner can appeal (P6.3).

**Done when.** In a simulation with 12 nodes, 3 pipelines and 1 bad node, the bad node is found
within 20 canaries. Effort: **M** (needs ≥ 2 pipelines to be useful).

### P6.6 Stage-level commitments (for blame)

**Research.** Verde: commit a Merkle root of per-step hashes; on a dispute, the referee re-runs
one step ([arXiv 2502.19405](https://arxiv.org/abs/2502.19405)).

**Our approach (later, needs a Parallax hook).** Each node hashes the hidden state it sends to the
next stage, for each request, using a TOPLOC-style top-k encoding so that small numeric noise does
not change the commit. On a dispute, re-run only the stage where the commits first differ. Only
start this after P6.1 works. Effort: **L**.

---

## P7. Incentives and reputation

**SPEC change needed for P7.1–P7.3.** SPEC §8.2 says earned credits have no expiry and SPEC §9.2
says no credit penalties. These items change that, so they need approval and a SPEC update in
the same change. The 90/5/5 split, the cost formula and the self-request rule do not change.

### P7.1 Vesting of earned credits

**Problem.** Earned credits can be spent at once, so there is nothing to take back for fraud.

**Our approach.** Credits earned in epoch `e` unlock at epoch `e + N` (N = 6 epochs = 1 hour at
600 s, configurable). New table `earned_lots(account_id, epoch, amount_mc, unlocked, clawed_back)`.
Spending order: starter → unlocked earned. The account page shows "locked / unlocked". HCS events
`credits_vested`, `credits_clawed_back`. On-chain HBAR: P8.1.

**Done when.** Tests: lot unlock at the right epoch; clawback reduces only locked lots; totals
match HCS replay. Effort: **M**.

### P7.2 Expiry of earned credits

**Our approach.** Unlocked earned credits expire 90 days after unlock (configurable), oldest
first. Use the same job as starter expiry. Event `credits_expired` with `kind = earned`.
Effort: **S**.

### P7.3 Fraud penalties and bans

**Our approach (SPEC §16.3: loss of unvested credits; ban on the World nullifier).** Only after a
final verdict (P6.3):
1. Take back all **locked** lots of the owner. They go to the **network reserve** (the same
   account that SPEC §8.3 already uses).
2. Ban the owner's World nullifier from registering nodes. The account can still spend its
   unlocked credits as a requester.
3. All steps go to HCS with the verification record IDs.

The ban is on the nullifier, so a new wallet does not reset it (one account per nullifier, MVP
rule). Effort: **M**.

### P7.4 Stage-level blame

**Our approach.** When P5.1 names the suspected stage, only that node gets a failure outcome and 0
credits for the failed part. Other nodes get credit for the tokens they produced. Until P5.1 is
reliable, keep the MVP rule (all nodes on the route get a failure). Effort: **S** (after P5.1).

### P7.5 Collusion detection

**Problem.** Two accounts can send requests to each other's pools to farm credits (the 5% burn
makes this cost money, but starter credits are free).

**Research.** Wash-trading detection uses graph features: cycles, repeated flows between the same
pairs, short holding times, shared funding sources. Up to 25% of NFT volume was wash trading in
one study ([arXiv 2312.16603](https://arxiv.org/pdf/2312.16603)). Product-side fixes (cool-downs,
**weight rewards by unique counterparties**) work better than detection alone
([Elliptic](https://www.elliptic.co/corpus/gen-2983/fraudulent-trading/wash-trading-detection-on-centralized-exchanges-and-nft-marketplaces.html)).
EigenTrust needs pre-trusted peers to resist groups of bad peers
([reliable reputations, 2008](https://jammalam.faculty.pstat.ucsb.edu/html/Some%20Publications/2008_ReliableReputationsOfNetworkedSystems.pdf)).

**Our approach (SPEC §16.3: flag repeated flows; no new incentive rule).** The MVP already has the
two defences from SPEC §8.4: the self-request rule and the 5% burn. Detection only adds flags:
1. Daily job reads the `requests` table and builds a graph: requester account → owner account,
   weight = credits.
2. Flags: (a) one requester gives > 50% of an owner's earnings; (b) cycles A→B→A with similar
   amounts; (c) both accounts created within 1 hour and only trade with each other.
3. A flag raises the check rate of that owner's pools to `p_max` (P6.2) and shows on an admin
   view. No automatic credit change. A credit penalty comes only from P7.3 after verification.

**Done when.** A simulated pair of colluding accounts is flagged in one day. Effort: **M**.

### P7.6 Reputation-based node cap (1 → 3 → 5)

**Our approach.** Max registered nodes per nullifier: 1 at start; 3 after 7 days with reliability
≥ 0.9 and ≥ 200 verified requests; 5 after 30 days with no strikes. Enforce in
`/nodes/register`. Effort: **S**.

### P7.7 Availability rewards

**Research.** Livepeer ranks orchestrators by stake, and its docs list throughput, latency and
reliability as key metrics; performance-based ranking has been proposed
([Livepeer incentive model](https://docs.livepeer.org/v2/Orchestrators/concepts/incentive-model),
[forum](https://forum.livepeer.org/t/livepeer-explorer-rewarding-top-performers-through-ui-changes/1479)).

**Our approach (SPEC §16.3: small credits for standby capacity when the pool needs it).** Paid
from the **network reserve** (SPEC §8.3), so the 90/5/5 split of each request does not change.
In an epoch where the pool's queue wait p95 > 5 s (from the MVP per-pool queue), every node that
was online (MVP heartbeats) gets `standby_rate × online_minutes`. `standby_rate` and the cap per
epoch are admin config values in `shared/config`, like `model_factor`. Effort: **S**.

### P7.8 Routing preferences and pool pinning

**Our approach.** Request header / body options: `x-gpupool-pool` (pin), `x-gpupool-min-rep`,
`x-gpupool-region`. Private pools: a pool flag `private = true` plus an allow-list of account IDs;
the router hides it from others. Arkiv shows private pools without the member list. Effort: **S**.

### P7.9 Passport credential tier

**Research.** World ID has an NFC document credential (passport, eID, My Number Card), valid up to
the document expiry (max 10 years); IDKit supports Proof of Human, document verification and
Selfie Check ([World docs](https://docs.world.org), [Biometric Update](https://www.biometricupdate.com/202412/world-id-keeps-growing-with-passport-credential-option)).

**Our approach (SPEC §16.3: optional stronger credential).** Login stays as in the MVP (Orb or
selfieCheck, action `gpupool-account`). Add the document (NFC) credential as an **optional
upgrade** on the account page. Store the credential level on the account and show it on Arkiv
account stats. Keep the **one account per nullifier** rule: first check with World whether a
person gets the same nullifier for the same action across credentials. If not, do not build this
until World confirms how to keep one account per person. Effort: **S**.

### P7.10 World Agent Pass (human-backed agents)

**Research.** World **AgentKit** (beta) lets a verified human delegate their World ID to AI
agents, combined with **x402**; several agents can link to one human, so platforms can apply
limits per person. Server side uses `@x402/hono` — the same stack as our gateway (Hono)
([PYMNTS](https://www.pymnts.com/?p=3569753),
[overview](https://beeble.com/en/blog/the-human-passport-for-bots-how-world-id-s-agent-kit-aims-to-tame-the-ai-wild-west)).

**Our approach.** An x402 request with an AgentKit proof is linked to the human's account: it
uses the human's ratio for priority, and an agent budget set on the account page. Plain x402
(without AgentKit) stays as today (ratio 1). Effort: **M** (beta API; check status first).

---

## P8. Hedera and Arkiv extensions

### P8.1 Contract v2: vesting, clawback, challenge window, settler checks

**Research.** UMA's OptimisticDistributor: post a Merkle root, then a **dispute window** before
claims; MerkleDistributor tracks `isClaimed(window, index)`
([UMA OptimisticDistributor](https://contracts.docs.umaproject.org/contracts/financial-templates/optimistic-distributor/OptimisticDistributor)).
Our current `EpochPayout.sol` already has `claimDelay` (60 s) and `sweepDelay` (7 days).

**Our approach.** `EpochPayoutV2.sol` (new deployment, no upgrade path needed):
1. `postEpoch(root, total)` → state `Pending`. Claims open after `challengeWindow` (e.g. 24 h).
2. `challenge(epoch, evidenceHash)` by a watcher role → state `Challenged` (claims blocked).
3. `resolve(epoch, newRoot)` by the owner (later: multisig) replaces the root with one that
   excludes the fraud, and returns the difference to the treasury.
4. Leaf adds `unlockEpoch` for vesting: `claim()` reverts before unlock.
5. **Settler checks on-chain:** `total` must equal `msg.value`; the post includes the HCS
   sequence number of the `epoch_closed` event, so anyone can compare the root with HCS
   (the MVP already publishes `epoch_closed` before posting).
6. Keep the tinybar unit tests (CLAUDE.md §4.7).

**Done when.** Foundry tests for challenge → resolve → claim, claim before unlock, and
double-claim. Testnet deploy verified on HashScan. Effort: **M**.

### P8.2 Scheduled Transactions (automatic settlement)

**Research.** HIP-423 (mainnet v0.57): schedule a transaction for an arbitrary future time, more
transaction types allowed. HIP-755 (v0.59): a Schedule Service **system contract**, so contracts
can schedule calls; `scheduleCall`, `scheduleCallWithPayer`, `hasScheduleCapacity`; HIP-1215
extends it to arbitrary contract calls
([HIP-423](https://hips.hedera.com/hip/hip-423),
[Hedera blog](https://hedera.com/blog/hip-755-hip-756-revolutionizing-smart-contract-capabilities-on-hedera),
[Schedule Service docs](https://docs.hedera.com/evm/hedera-services/system-contracts/schedule-service)).

**Our approach (SPEC §16.4: automatic epoch settlement).** Keep the MVP settlement order:
epoch close → Merkle tree → HCS `epoch_closed` → treasury funds settler → `postEpoch`. Only the
timing moves to Hedera: after `postEpoch`, schedule the **sweep** of unclaimed funds at
`sweepDelay` as a scheduled transaction, so it runs without a gateway timer.

**Done when.** On testnet, an epoch is swept automatically with no gateway action after posting.
Effort: **S–M**.

### P8.3 USDC payments (HTS)

**Research.** Testnet USDC token ID **0.0.429274** (mainnet 0.0.456858), 6 decimals; the receiving
account must be **associated** with the token, or the transfer fails with `TOKEN_NOT_ASSOCIATED`.
Circle faucet supports Hedera testnet. The x402-hedera repo (alpha) supports HTS tokens
([Circle](https://www.circle.com/multi-chain-usdc/hedera),
[x402-hedera](https://github-users.yhajoa.workers.dev/hedera-dev/x402-hedera),
[r402-hedera](https://docs.rs/r402-hedera)).

**Our approach.** Add `USDC` as a second x402 asset on the **same x402 path** (price in USDC
micro-units from the same token price). Associate the treasury with 0.0.429274. Payouts stay as
in the MVP: HBAR per epoch through the Merkle claim. USDC income stays in the treasury and is
counted into the epoch's HBAR total at a fixed rate in config. (USDC payouts through the contract
need HTS calls; only consider that if HBAR payouts are not enough.)

**Done when.** The agent client pays one request in testnet USDC; the receipt shows the HTS
transfer. Effort: **M**.

### P8.4 ERC-8004 (register the gateway as an agent)

**Research.** ERC-8004 "Trustless Agents" (draft, Aug 2025): three registries: **Identity**
(ERC-721; token URI → registration file with endpoints), **Reputation** (feedback 0–100, tags,
optional off-chain file + hash), **Validation** (validators post results). Payment-agnostic, but
x402 proofs can be referenced in feedback
([erc-8004-contracts](https://github.com/erc-8004/erc-8004-contracts),
[Polygon docs](https://docs.polygon.technology/payment-services/agentic-payments/erc8004)).

**Our approach.** Deploy the reference registries on Hedera testnet (EVM) or use an existing
deployment. Register the gateway (one identity; the registration file lists `/v1/chat/completions`,
x402 terms, supported models from Arkiv). Agent clients write feedback that references their x402
payment ID. Later: P6 verification results → Validation Registry. Effort: **S–M**.

### P8.5 Swarm receipt bundles

**Research.** Uploads need a running **Bee** node on Gnosis Chain funded with xBZZ and xDAI; buy a
**postage batch** (usable after about 8 confirmations; HTTP 422 before that), then
`uploadFile/uploadData` → 64-hex reference. Ultra-light nodes cannot upload
([Swarm docs](https://docs.ethswarm.org/docs/develop/upload-and-download),
[bee-js](https://bee-js.ethswarm.org/docs/upload-download/)).

**Our approach.** At each epoch close (the MVP settlement worker step): build a bundle (all
receipts, routes, Merkle tree) as one JSON file; upload; add the Swarm reference as a field of the
existing `epoch_closed` HCS event. Transcripts are **not** uploaded (privacy) — only the hashes the
MVP already keeps.

**Done when.** Anyone can rebuild an epoch's Merkle root from the Swarm bundle alone. Effort: **S**
(plus Bee node setup).

### P8.6 Multiple gateways sharing HCS and Arkiv state

**Research.** HCS gives one **consensus order** for all messages on a topic; mirror-node
subscribers get messages in that order with sequence numbers and running hashes, usually a few
seconds after consensus. The public mirror node has no uptime guarantee
([HCS gRPC API](https://docs.hedera.com/hedera/~/changes/2881/sdks-and-apis/hedera-consensus-service-api),
[mirror node architecture](https://docs.hedera.com/operators/mirror-node/architecture.md)).

**Our approach.** Keep the MVP ledger model: each gateway has its own working copy, every balance
change goes to the **same HCS topic**, and requests **never wait** for HCS (`CLAUDE.md` §4.9).
1. Each gateway reads the topic from the mirror node and applies other gateways' events to its
   working copy in consensus order (the MVP already says anyone can rebuild balances from HCS).
2. To stop double spending without waiting for HCS, each gateway gets a **credit lease** per
   account: a slice of the balance reserved for that gateway, granted and returned with HCS
   events. Holds and settlement work as in the MVP inside the lease.
3. Arkiv stays the shared directory. Each gateway writes only its own entities (owner-scoped).
4. Run our own mirror node or a paid provider for production.

**SPEC change needed:** new HCS event types for lease grant/return (added to `shared/` first).

**Done when.** Two gateways on one topic: the same account spends from both and no balance goes
negative in a fuzz test. Effort: **L**.

### P8.7 Postgres

**Our approach.** Only together with P8.6 or when one gateway passes about 50 requests/s of
writes. Store the nullifier as `NUMERIC(78,0)` or `TEXT` (keep TEXT for the same code). Use
`pg` + a thin query layer; keep money math in BigInt. The DB stays a working copy; HCS stays the
record. Effort: **M**.

---

## P9. Scale-out

### P9.1 Automatic pool formation (< 5 ms delay)

**Research.** **Vivaldi** network coordinates (SIGCOMM 2004): each host gets coordinates so that
the distance predicts RTT; fully decentralized; 2-D + height gives 11% median error on 1,740
Internet hosts. Malicious nodes can distort coordinates
([paper](https://vm-web.pdos.csail.mit.edu/papers/vivaldi:sigcomm/paper.pdf),
[Wikipedia](https://en.wikipedia.org/wiki/Vivaldi_coordinates)).

**Our approach.** On one LAN, measure directly: each node agent pings the other candidate nodes
(≤ 50) and reports the RTT matrix in its MVP heartbeat. The gateway clusters with a threshold
graph (edge if RTT < 5 ms and both are wired), and checks that each cluster has enough memory for
one model from the Arkiv catalog. The cluster then starts as a normal MVP pool: one coordinator
runs the Parallax scheduler, members join with the `pool/` scripts, and the coordinator writes
`gpupool.pool` to Arkiv. **Parallax still places the layers** inside the pool. Use Vivaldi only when there are too many
nodes to ping all pairs (WAN). Do not trust self-reported RTT alone: the gateway spot-checks with
its own pings.

**Done when.** 6 nodes on two switches form 2 pools without manual config. Effort: **M**.

### P9.2 Many pools and coordinator election

**Our approach.** Pool coordinator = the member with the highest reliability that has a
scheduler-capable machine (≥ 8 GB free). The gateway decides (it already has all scores), and
writes `coordinator_node_id` in the Arkiv pool entity. If the coordinator's heartbeat is missing
for 30 s: the gateway picks the next one, sets the pool to `restarting`, and members rejoin the
new scheduler (weights already on disk; P5.5). No consensus algorithm is needed while there is one
gateway; with several gateways (P8.6), the election result is an HCS message, so all gateways
agree by consensus order. Effort: **M**.

### P9.3 WAN / Global Host and relays

**Research.** libp2p **DCUtR** hole punching: **70% ± 7.1%** success after relay reservation, from
4.4 million attempts in 167 countries; TCP and QUIC the same; 97.6% of successes on the first
try. It always needs a **circuit relay** first
([arXiv 2510.27500](https://arxiv.org/html/2510.27500v1),
[ProbeLab](https://probelab.io/blog/can-libp2p-punch-through-nats/)). Petals ran 4 of 14 servers
behind firewalls with libp2p relays. Petals over the real internet: 0.83 steps/s (BLOOM-176B).

**Our approach.** Parallax uses Lattica (libp2p-based). Run 1–2 relay nodes we control. Allow
cross-network pools only for models where the per-token hop latency budget allows it (estimate
with the alpha-beta model, `research-notes.md` Problem 6). Keep the 30% of nodes that fail hole
punching as single-node pools (whole small model) instead of pipeline members. Effort: **L**.

### P9.4 Speculative decoding and batching tuning

**Research.**
- **FlowSpec** (2025/26): pipeline-parallel, tree-based speculative decoding for edge devices;
  1.37×–1.73× decode speed-up against strong baselines; code on GitHub
  ([arXiv 2507.02620](https://arxiv.org/abs/2507.02620)).
- Dovetail's 1.8–10× was **one machine** (CPU + GPU), not a network (`research-notes.md` Part 5).
- SGLang (Parallax's backend) supports EAGLE-style speculative decoding on a single engine.

**Our approach.** First measure: draft model (Qwen3-0.6B) on the coordinator, target pipeline in
Parallax. Expect ~1.4–1.7× at best (FlowSpec numbers). Only build it if a test shows ≥ 1.3× on our
3-node pool. Batching: raise the MVP's "one inference per pool" to N concurrent requests after
measuring per-request slowdown (Petals: 8 users cost ~20% each). Effort: **M** (measure) → **L**
(build).

### P9.5 Privacy (first layers on trusted nodes, encryption)

**Research.** Intermediate states in split/pipeline inference leak prompts; recent attacks recover
text from hidden states with high accuracy, and inversion is easier than earlier work said
([arXiv 2501.05965](https://arxiv.org/pdf/2501.05965),
[arXiv 2605.23158](https://arxiv.org/pdf/2605.23158),
[arXiv 2503.09291](https://arxiv.org/pdf/2503.09291) — attacks on distributed LLM frameworks).
Defences: mutual-information regularization (ADMI,
[arXiv 2606.14210](https://arxiv.org/abs/2606.14210)), orthogonal basis rotation
([arXiv 2606.16461](https://arxiv.org/pdf/2606.16461)) — both partial.

**Our approach (honest version).**
1. **Transport encryption** between nodes (TLS / Noise in libp2p) — protects against the venue
   network, not against pool members.
2. **Trusted first and last stages:** the embedding + first blocks and the final blocks + LM head
   run on a node the requester trusts (their own node, or the operator's). Router option
   `x-gpupool-privacy: trusted-ends`.
3. **Private pools** (P7.8) for sensitive users.
4. Do **not** claim that middle stages cannot read prompts. State this in the docs.

**Done when.** A request with `trusted-ends` is placed only on routes where stage 1 and the last
stage are on allowed nodes. Effort: **M** (needs placement control through a Parallax hook).

---

## Legal check for real-money payouts

**Research.** India (venue and team): VDA service providers that do crypto–fiat exchange,
transfers or custody must register with **FIU-IND** as reporting entities under PMLA, also when
offshore; guidelines updated 8 Jan 2026; FIU-IND sent notices to 15 VDA SPs in Sept 2026
([newsonair](https://newsonair.gov.in/fiu-ind-cracks-down-on-15-vda-service-providers-over-pmla-non-compliance/),
[CryptoSlate profile](https://cryptoslate.com/crypto-laws/india-pmla-vda-service-provider-aml-cft-regime/)).
Paying users crypto for compute is not clearly covered by these sources. Tax on VDA income also
applies to providers.

**Our approach.** Before mainnet: (1) get a written opinion from a lawyer for each launch country
on: payouts for compute, the credit system (is it a stored-value instrument?), custody of
treasury funds; (2) add KYC only where the opinion requires it (World ID is proof of personhood,
not KYC); (3) keep testnet until then. **Not an engineering task — owner: project lead.**

---

## Appendix A. Dependency graph

```
P5.1 stall ─┬─> P5.2 failover
            └─> P7.4 stage blame
P5.4 admission ──> P5.9 cross-check
P6.1 Token-DiFR ─┬─> P6.2 check rate ─> P7.3 penalties
                 ├─> P6.3 appeals ────> P7.3 penalties
                 ├─> P6.5 group testing
                 └─> P6.6 stage commits
P7.1 vesting ─┬─> P7.3 penalties
              ├─> P6.2 (S = unvested credits)
              └─> P8.1 contract v2 ─> P8.2 scheduled tx
P8.6 multi-gateway ─> P8.7 Postgres, P9.2 election via HCS
P9.1 auto pools ─> P9.2 many pools ─> P9.3 WAN
```

## Appendix B. Suggested first 4 weeks after the hackathon

| Week | Work | Exit check |
|---|---|---|
| 1 | P5.1, P5.3, P5.4, P5.6, P5.7 | No synchronized joins; no ghosts; stall ends in ≤ 6 s |
| 2 | P5.2, P5.5, P5.8 | Kill a node mid-reply → one continuous answer |
| 3 | P6.1 (reference node + calibration), P6.2 | 4-bit cheater flagged; 0 false flags in 10k |
| 4 | P7.1, P6.3, P7.3, P8.1 | Fraud → appeal → clawback, on HCS and testnet |

---

## 9. Sources

**Inference and resilience**
- Petals — [arXiv 2209.01188](https://arxiv.org/abs/2209.01188); [fault-tolerance PR #91](https://github.com/bigscience-workshop/petals/pull/91); [NeurIPS 2023, arXiv 2312.08361](https://arxiv.org/abs/2312.08361)
- SpotServe — [arXiv 2311.15566](https://arxiv.org/abs/2311.15566)
- KevlarFlow — [arXiv 2601.22438](https://arxiv.org/html/2601.22438v1)
- Parallax — [arXiv 2509.26182](https://arxiv.org/abs/2509.26182); [releases](https://github.com/GradientHQ/parallax/releases); [docs](https://docs.gradient.network/the-open-intelligence-stack/parallax)
- Gateway stream failover — [api7/aisix #882](https://github.com/api7/aisix/pull/882); [ExLLM StreamRecovery](https://hexdocs.pm/ex_llm/0.5.0/ExLLM.StreamRecovery.html)
- FlowSpec — [arXiv 2507.02620](https://arxiv.org/abs/2507.02620)
- MLX memory — [memory.cpp](https://docs.rs/crate/mlxrs-sys/latest/source/vendor/mlx/python/src/memory.cpp); [guide](https://localaimaster.com/blog/mac-memory-pressure-local-llm)

**Verification**
- DiFR / Token-DiFR — [arXiv 2511.20621](https://arxiv.org/abs/2511.20621); [ICML 2026](https://icml.cc/virtual/2026/78608)
- TOPLOC — [arXiv 2501.16007](https://arxiv.org/abs/2501.16007); [ICML 2025](https://proceedings.mlr.press/v267/ong25a.html)
- Proof of Sampling — [arXiv 2405.00295v3](https://arxiv.org/html/2405.00295v3); [Hyperbolic blog](https://hyperbolic.ai/blog/deep-dive-into-hyperbolic-proof-of-sampling)
- Verde — [arXiv 2502.19405](https://arxiv.org/abs/2502.19405)
- SGLang deterministic inference — [LMSYS blog](https://lmsys.org/blog/2025-09-22-sglang-deterministic/); [docs](https://docs.sglang.io/advanced_features/deterministic_inference.html); LLM-42 [arXiv 2601.17768](https://www.arxiv.org/pdf/2601.17768)
- LOGIC — [Inference.net](https://inference.net/blog/logic/)
- GPU timing proofs — [arXiv 2602.09369](https://www.arxiv.org/pdf/2602.09369); evasion [GreaterWrong](https://www.greaterwrong.com/posts/Jqb8Ev6hRgPqX8fGa/whitebox-evasion-is-the-baseline-for-gpu-workload); [io.net PoW](https://docs.io.net/docs/proof-of-work)
- Group testing — [Jain et al. 2023](https://ar5iv.arxiv.org/html/2305.06526); [arXiv 2607.02187](https://arxiv.org/pdf/2607.02187)

**Incentives**
- Wash trading — [arXiv 2312.16603](https://arxiv.org/pdf/2312.16603); [Elliptic](https://www.elliptic.co/corpus/gen-2983/fraudulent-trading/wash-trading-detection-on-centralized-exchanges-and-nft-marketplaces.html)
- Reputation and collusion — [Reliable reputations, 2008](https://jammalam.faculty.pstat.ucsb.edu/html/Some%20Publications/2008_ReliableReputationsOfNetworkedSystems.pdf)
- Livepeer — [incentive model](https://docs.livepeer.org/v2/Orchestrators/concepts/incentive-model); [forum](https://forum.livepeer.org/t/livepeer-explorer-rewarding-top-performers-through-ui-changes/1479)
- World — [developer docs](https://docs.world.org); [passport credential](https://www.biometricupdate.com/202412/world-id-keeps-growing-with-passport-credential-option); AgentKit [PYMNTS](https://www.pymnts.com/?p=3569753)

**Hedera, Arkiv, Swarm, ERC-8004**
- [HIP-423](https://hips.hedera.com/hip/hip-423); [HIP-755/756 blog](https://hedera.com/blog/hip-755-hip-756-revolutionizing-smart-contract-capabilities-on-hedera); [Schedule Service](https://docs.hedera.com/evm/hedera-services/system-contracts/schedule-service)
- [HCS gRPC API](https://docs.hedera.com/hedera/~/changes/2881/sdks-and-apis/hedera-consensus-service-api); [mirror node](https://docs.hedera.com/operators/mirror-node/architecture.md)
- USDC — [Circle](https://www.circle.com/multi-chain-usdc/hedera); [x402-hedera](https://github-users.yhajoa.workers.dev/hedera-dev/x402-hedera); [r402-hedera](https://docs.rs/r402-hedera)
- ERC-8004 — [contracts](https://github.com/erc-8004/erc-8004-contracts); [Polygon docs](https://docs.polygon.technology/payment-services/agentic-payments/erc8004)
- Swarm — [docs](https://docs.ethswarm.org/docs/develop/upload-and-download); [bee-js](https://bee-js.ethswarm.org/docs/upload-download/)
- UMA — [OptimisticDistributor](https://contracts.docs.umaproject.org/contracts/financial-templates/optimistic-distributor/OptimisticDistributor); [liveness](https://docs.uma.xyz/developers/setting-custom-bond-and-liveness-parameters)

**Network and privacy**
- Vivaldi — [SIGCOMM 2004](https://vm-web.pdos.csail.mit.edu/papers/vivaldi:sigcomm/paper.pdf)
- libp2p DCUtR — [arXiv 2510.27500](https://arxiv.org/html/2510.27500v1); [ProbeLab](https://probelab.io/blog/can-libp2p-punch-through-nats/)
- Split-inference privacy — [2501.05965](https://arxiv.org/pdf/2501.05965); [2605.23158](https://arxiv.org/pdf/2605.23158); [2503.09291](https://arxiv.org/pdf/2503.09291); [2606.14210](https://arxiv.org/abs/2606.14210); [2606.16461](https://arxiv.org/pdf/2606.16461)

**Legal**
- FIU-IND / PMLA — [newsonair](https://newsonair.gov.in/fiu-ind-cracks-down-on-15-vda-service-providers-over-pmla-non-compliance/); [CryptoSlate](https://cryptoslate.com/crypto-laws/india-pmla-vda-service-provider-aml-cft-regime/)
