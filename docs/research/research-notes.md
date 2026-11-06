# Campus GPU Pool: Problems, Solutions, and Sources

Learning notes for the Campus GPU Pool project. Each problem uses the same format:

- **What**: the problem in plain words
- **Why**: why it happens and why it matters for this project
- **How**: the method from a research paper to copy, step by step
- **Source**: the paper or system it comes from

Part 0 explains the basic terms. Read it first if GPU inference is new to you.

---

## Part 0: Basic terms

### Models, layers, and weights

- **LLM (large language model)**: a program that predicts the next word piece, over and over, to build a reply.
- **Token**: one word piece. "unbelievable" might be 3 tokens. Speed is measured in **tokens per second (tok/s)**. About 5 tok/s reads like slow typing. About 20+ tok/s feels quick.
- **Parameters / weights**: the numbers the model learned in training. "8B" means 8 billion numbers. To run the model, the GPU must hold them all in memory.
- **Layers / blocks**: a model is a stack of identical blocks, for example 64 for a 32B model. Text goes in at the bottom, passes through every block in order, and the next token comes out at the top. Because the blocks run in order, you can cut the stack into pieces and put each piece on a different machine.
- **Embedding layer**: the very first step. It turns tokens into numbers the blocks can work on.
- **Inference**: running a trained model to get answers (as opposed to training it). This project only does inference.
- **Forward pass**: one trip of data through all the layers. Generating one token takes one forward pass.

### GPU memory and speed

- **VRAM**: the GPU's own memory. Laptop GPUs have 4–8 GB. The model weights must fit here or it will not run at a useful speed.
- **Quantization**: storing each weight with fewer bits so the model takes less memory.
  - Original: 16 bits per weight. An 8B model is about 16 GB.
  - 8-bit: about half the size. 4-bit: about a quarter. An 8B model at 4-bit is about 5 GB.
  - Quality drops only a little at 4-bit.
- **GGUF / Q4_K_M**: the file format and a common 4-bit setting used by llama.cpp.
- **Memory bandwidth**: how fast the GPU can read its VRAM, in GB/s. An RTX 4060 laptop GPU reads about 256 GB/s.
  - To make one token, the GPU reads every weight once.
  - So: **max tok/s ≈ bandwidth ÷ model size**.
  - Example: a 5 GB model on a 256 GB/s GPU gives at most about 50 tok/s.
  - This is why bandwidth, not raw compute, usually limits speed for one user.
- **KV cache**: memory where the model keeps notes about earlier tokens in the conversation, so it does not redo work. It grows with conversation length and also takes VRAM.
- **Prefill vs decode**:
  - Prefill: reading your whole prompt at once. Fast per token.
  - Decode: producing the reply one token at a time. This is the slow part.
- **TPOT (time per output token)**: how long each new token takes during decode. Lower is better. 175 ms TPOT ≈ 5.7 tok/s.

### Splitting one model across machines

- **Pipeline parallelism**: cut the layer stack into ranges. Laptop A runs layers 1–20, B runs 21–40, C runs 41–64.
  - For each token, A sends a small result to B, and B sends one to C.
  - Simple, and needs little network traffic. **This project uses it.**
- **Tensor parallelism**: split *every* layer across machines.
  - The machines must talk to each other several times inside every layer.
  - Needs a very fast link between GPUs. Too slow over a normal network. **Not used here.**
- **Activations / hidden states**: the in-between result one stage passes to the next. For one token it is small, about 8–16 KB.
- **Stage**: one machine's slice of the pipeline.
- **Latency vs bandwidth (network)**:
  - Latency: how long a message takes to arrive (ms).
  - Bandwidth: how much data per second the link carries.
  - Pipeline inference sends many tiny messages, so **latency matters far more than bandwidth**. That is why wired Ethernet (about 0.1–1 ms) beats Wi-Fi (5–50 ms with jitter).
- **RTT (round-trip time)**: time for a message to go and a reply to come back.
- **Batching**: processing several users' requests together. It is almost free, because the weights are read once for the whole batch.

### Speculative decoding

- A small, fast **draft model** guesses the next several tokens.
- The big model then checks all those guesses in a single pass.
- Correct guesses are kept. At the first wrong guess, the rest are dropped.
- When the draft guesses well, you get several tokens for the cost of one big-model pass.

### Checking work and trust

- **Logprobs**: the model's confidence score for each possible next token. Two machines running the same model give nearly the same logprobs. A smaller or cheaper model gives noticeably different ones.
- **Determinism**: same input gives the exact same output, bit for bit.
  - GPUs often are *not* deterministic across different hardware.
  - Floating-point math gives tiny different results depending on the order of additions: (a+b)+c can differ slightly from a+(b+c).
  - Different GPUs add things up in different orders.
- **Hash**: a short fingerprint of data. If even one bit changes, the hash changes completely. Comparing two hashes is a cheap way to ask "are these exactly equal?"
- **Merkle tree**: hashes of hashes, built up into one "root" hash.
  - The root commits to every piece underneath.
  - Later you can prove any single piece was part of the set by showing a short path of hashes.
- **Stake / slashing**:
  - Stake: a node owner locks up a deposit.
  - Slashing: if the node is caught cheating, part of the deposit is taken away.
- **Nash equilibrium**: a situation where no player gains by changing strategy alone. Here, a setup where "be honest" is every node's best choice.

### Tools named in these notes

- **llama.cpp**: popular open-source program for running GGUF models on laptops. Its **RPC mode** lets one main computer use other computers' GPUs as extra memory.
- **DHT (distributed hash table)**: a shared key-value store spread across many machines, with no central server. On a single LAN, one coordinator with an in-memory table does the same job.
- **TTL (time to live)**: an entry deletes itself if it is not refreshed in time. Good for spotting dead nodes.

---

## Part 1: Splitting the model across laptops

### Problem 1: Which laptop gets which layers?

**What.** You have laptops with different amounts of VRAM and different speeds. You must decide which range of layers each one runs.

**Why.**
- A pipeline is only as fast as its slowest stage. Every token waits for every stage in turn.
- If a slow laptop gets too many layers, everyone waits on it.
- If a laptop gets more layers than fit in its VRAM, the model does not load at all.
- Layers should be **contiguous** (next to each other). If a laptop runs layers 1–10 and 30–40, data has to leave and come back, and every extra network hop adds latency.

**How (water-filling).**
1. For each laptop *i*, measure two things:
   - `c_i`: how many layers fit in its VRAM, after reserving room for the KV cache and activations. Never plan for 100% of VRAM.
   - `F_i`: how fast it computes, from a short benchmark at registration.
2. Pick a scaling number `λ`. Give each laptop `min(c_i, λ × F_i)` layers. Faster laptops get more layers, but never more than fit.
3. Use binary search on `λ` until the layer counts add up to exactly the total number of layers.
4. The counts come out as fractions (like 12.6). Round them with the **largest-remainder method**: round all down, then give the leftover layers to the laptops with the biggest fractional parts.
5. Turn the counts into contiguous ranges in order: laptop A gets 1–13, B gets 14–30, and so on.

The name comes from pouring water into containers of different sizes: the level rises evenly until the small containers are full.

**Simpler rule with the same idea (Berkeley).** Fill one machine's memory completely before moving to the next. Fewer machines in the chain means fewer network hops.

**Skip:** Parallax also has a step that picks how many full copies of the model to run, and a "region-aware" rule. On one campus LAN you are a single region and will likely run one pipeline, so these are not needed yet.

**Source:**
- Parallax, Phase 1 (arXiv 2509.26182)
- Berkeley EECS-2024-111, greedy heuristic
- Petals, contiguous intervals (arXiv 2209.01188)

---

### Problem 2: Picking a path for each request when spare nodes exist

**What.** Suppose two laptops both hold layers 21–40 (one is a spare). For each new chat request, which laptops should form its chain?

**Why.**
- Different choices give different speeds. One copy may be busy, slower, or further away on the network.
- Choosing badly makes some requests needlessly slow.
- Checking every possible combination grows very fast as nodes are added.

**How (shortest path through a layer graph).**
1. Draw a graph. Each point is a pair **(layer, laptop that holds it)**.
2. Connect each point to the points for the *next* layer:
   - Same laptop: cost about 0.
   - Different laptop: cost = the network time between them (`ρ`).
3. Each point also has its own cost: the time that laptop takes to run that layer (`τ`).
4. Go from layer 1 to the last layer. At each point, keep the cheapest total cost to reach it, and remember which point it came from. This is dynamic programming (DP).
5. At the last layer, take the cheapest point and follow the "came from" links backwards. That is the chain.
6. **Pin the chain for the whole request.** The KV cache for that conversation now lives on those laptops, so switching mid-reply would lose it.

It is fast: the paper measured about 0.01 ms per request with 4 GPUs.

**Alternative:** Petals pings nearby servers to measure latency, then uses beam search (keep only the best few partial paths at each step). Parallax's DP is cleaner.

**Source:**
- Parallax, Phase 2 (arXiv 2509.26182)
- Petals routing (arXiv 2209.01188)

---

### Problem 3: Laptops joining and leaving

**What.** Students open and close laptops all day. The layer layout must adapt without stopping everything.

**Why.**
- If the only laptop holding layers 21–40 leaves, the model cannot run at all.
- If you reshuffle every layer each time someone joins, every laptop must reload weights, which takes minutes.
- You want small local fixes most of the time and a big reshuffle only when truly needed.

**How.**
1. **Join**: the new laptop looks for the layers with the *least* coverage (fewest copies, or least spare capacity). It takes a contiguous range starting there, as large as its VRAM allows.
2. **Leave**: release that laptop's layers. Its entries in the metrics table expire (see Problem 4).
3. **Full rebalance** only when either:
   - some layer has **no** node holding it, or
   - load is badly uneven. Measure the **coefficient of variation** (standard deviation ÷ average) of per-layer load, and act when it passes a set threshold. Parallax defines load as 50% KV cache use + 50% compute use.
4. Petals adds: each server checks now and then whether moving to other layers would raise total throughput noticeably. If yes, it moves.

**Source:**
- Parallax, dynamic membership (arXiv 2509.26182)
- Petals, load balancing (arXiv 2209.01188)

---

### Problem 4: Keeping live information about every node

**What.** The router (Problem 2) needs current numbers: how fast each laptop is right now, network times between laptops, and free memory.

**Why.**
- Laptops change constantly. The owner opens a game, the GPU heats up and slows down (thermal throttling), the battery saver kicks in.
- Old numbers lead to bad routing.
- Dead nodes must vanish from the table quickly, or requests get sent to them.

**How.**
1. Every 1–2 seconds, each node publishes:
   - `τ`: time per layer
   - `ρ`: round-trip time to each other node
   - free KV cache capacity, counted in tokens it can still hold
2. Each entry has a **TTL**. If a node stops refreshing, its entries delete themselves.
3. When the router assigns or releases a chain, update that node's numbers immediately. Do not wait for the next refresh.
4. Parallax stores this in a DHT. **On a single LAN, a table in the coordinator's memory with TTLs is enough.**

**Source:** Parallax (arXiv 2509.26182)

---

## Part 2: Staying alive when things break

### Problem 5: A laptop dies in the middle of a reply

**What.** Someone unplugs a laptop while it is serving stage 2 of a live chat.

**Why.**
- That laptop held the **KV cache** (the conversation memory) for its layers.
- A replacement laptop has the same weights but not that memory, so it cannot simply continue.
- Restarting the whole request from scratch wastes all work so far and the user sees a long pause.

**How (replay the inputs).**
1. Each server keeps the KV cache for its active sessions, as normal.
2. The **client** (in this project, the coordinator) also keeps a copy of **every input it sent to each server** during the session. These are small, a few KB per token.
3. When a server fails:
   1. Remove it from the table.
   2. Re-run routing (Problem 2) to find a replacement holding the same layers.
   3. Send the replacement *all* the saved inputs for that session, in one batch.
   4. The replacement processes them and rebuilds the same KV cache.
4. Generation continues from where it stopped.

Brief section 3.6 already describes this idea. Petals is where it is proven to work.

**Warning:** stock llama.cpp RPC does not do this. One dead RPC server usually ends the session. You need your own coordinator in front.

**Note:** Parallax handles nodes joining and leaving between requests, but **not** a crash in the middle of one.

**Source:** Petals, fault tolerance section (arXiv 2209.01188)

---

### Problem 6: Unreliable laptops vs a stable backbone

**What.** Laptops come and go. Lab desktops stay on. How do you plan around both?

**Why.**
- If every part of the model depends on laptops, the service fails whenever students leave (lunch, exams, nights).
- You need a reliable core and extra capacity on top.

**How.**
1. Split nodes into two groups:
   - **Supernodes**: stable, long-running, more powerful. In this project, lab desktops.
   - **Antnodes**: come and go, less powerful. In this project, student laptops.
2. A central **broker** (your coordinator) registers each node with a unique ID.
3. The broker sends **ping/pong heartbeats** on a timer. No reply in time means the node is offline.
4. If an offline node had unfinished work, the broker hands that work to a node from a **backup pool**: spare nodes kept ready.
5. To predict how long data takes to send between two nodes, use the **alpha-beta model**:
   `time = α + β × message_size`
   - α = fixed latency per message
   - β = time per byte (1 ÷ bandwidth)
   - Measure α and β for each link when a node registers.

**Source:** FusionAI, sections 3.2–3.3 (arXiv 2309.01172)

---

## Part 3: Speed and network

### Problem 7: Network traffic between stages

**What.** Each stage sends hidden states to the next. Can that be made smaller?

**Why.**
- Over slow links, less data means faster transfer.
- **On wired gigabit Ethernet this hardly matters.** Petals found speed depends on latency, not bandwidth. Treat this as low priority.

**How.**
- **Dynamic blockwise 8-bit quantization** of hidden states before sending:
  1. Split the numbers into small blocks.
  2. Store each block with its own scale and 8 bits per number.
  3. This halves the traffic, with almost no quality loss.
- Petals also stored *weights* in 8-bit (LLM.int8). That is outdated. GGUF 4-bit used by llama.cpp is smaller and widely used now.

**Source:** Petals (arXiv 2209.01188)

---

### Problem 8: Making each reply faster (speculative decoding)

**What.** Pipeline decoding is slow because every token travels through every laptop in turn. Can you get several tokens per trip?

**Why.**
- Each token costs a full trip through the pipeline: compute time plus a network hop per stage.
- If each trip produced 3–4 tokens instead of 1, the reply would feel 2–3× faster.

**How.**
1. Run a small, fast **draft model** on one machine (for example, the coordinator).
2. The draft guesses the next several tokens, arranged as a small **tree of guesses** (several possible continuations).
3. Send all the guesses through the big pipeline **in one pass**. The big model checks them all at once.
4. Keep every guess the big model agrees with, up to the first disagreement. Throw away the rest.
5. Ideas worth copying from Dovetail:
   - When checking is slow (as in a laptop pipeline), use **fewer guesses per round**: 16 instead of 60. Each check then costs less.
   - A **deeper** draft model (4 blocks) guesses better. In their tests, on average about 5 guesses were accepted per round.

**Practical note:**
- Dovetail's draft model is a special head trained for each big model (they trained it on 4 data-center GPUs).
- For this project, a ready-made small model from the same family is easier. Example: a 0.5B model drafting for a 32B model.
- llama.cpp supports this with a draft-model option.

**Warning:** Dovetail tested **one machine** (big model checking on the CPU, draft on the GPU). It never tested a pipeline over a network. The brief's "1.8–10×" figure does not carry over to this project. Benchmark it yourself.

**Source:** Dovetail, EMNLP 2025 (arXiv 2412.18934)

---

### Problem 9: Privacy of user prompts

**What.** Can a laptop owner read the prompts passing through their machine?

**Why.**
- The laptop holding the **first** layers receives data that is very close to the raw input.
- It can recover the user's prompt text from it.
- Laptops holding later layers see more processed data, which is harder (but not proven impossible) to read.

**How.**
1. Keep the **embedding layer** on the coordinator, which you control. Ideally keep the first block there too.
2. Send only processed hidden states out to the laptops.
3. For truly sensitive users, offer a **private swarm**: only trusted nodes, isolated from the rest.

**Source:** Petals, privacy discussion (arXiv 2209.01188)

---

### Problem 10: Nodes behind firewalls

**What.** Many laptops cannot accept incoming connections because of campus firewalls, NAT, or Wi-Fi client isolation.

**Why.** If the coordinator cannot reach a node, that node cannot serve.

**How.**
- Have **nodes connect out** to the coordinator and keep that connection open. Outgoing connections usually pass through firewalls.
- Petals ran 4 of its 14 real-world servers behind firewalls using **libp2p Circuit Relay**: a public relay forwards traffic both ways.
- **Warning:** stock llama.cpp RPC works the other way round. The main computer connects *to* each RPC server. You need your own connection layer.

**Source:** Petals, real-world experiment (arXiv 2209.01188)

---

## Part 4: Catching cheaters

### Problem 11: How often should you check a node's work?

**What.**
- A dishonest node can save electricity by running a smaller or cheaper model and still claim payment.
- Checking every answer doubles your cost.
- How often must you check so that cheating never pays?

**Why.**
- Check too rarely and cheating becomes profitable.
- Check too often and you waste GPU time.
- You want the **smallest** check rate at which honesty is the best strategy.

**How (Proof of Sampling).**
1. A random node A answers a request.
2. With probability **p**, a second random node B re-runs the same request with the same seed.
3. Compare the two **hashes** of the outputs. Cheap.
4. If they differ, other nodes vote. A 2/3 majority decides. The cheater is slashed, and the user is compensated.
5. Set p using:

   **`p > C / ((1 − r) × (R + S))`**

   - `C` = cost to compute the job
   - `R` = reward for the job
   - `S` = slash amount (stake lost if caught)
   - `r` = fraction of nodes an attacker might control

   Example from the paper: r = 10%, S = 150 × C, R = 1.2 × C. Then p ≈ 0.74%, so you check less than 1 in 100 requests.
6. **Key lesson: larger stakes allow fewer checks.** This turns the brief's open "canary rate" parameter (section 5.4) into a calculation.

**Source:** Proof of Sampling, Hyperbolic (arXiv 2405.00295)

---

### Problem 12: Finding exactly where a cheater went wrong

**What.** Two nodes disagree on a result. Re-running the whole job to settle it is expensive. Can you find the single step where they first differ?

**Why.**
- The judge (a referee, or a smart contract) has little compute.
- It cannot re-run a big model, but it *can* check one small step.

**How (refereed delegation).**
1. While working, each node records a **hash** of the input and output of every operation (or every stage).
2. It builds those hashes into a **Merkle tree** and publishes only the root.
3. On a dispute, the referee compares the two nodes' hash lists and finds the **first** point where they differ.
4. Both nodes reveal the data for that one step only. Merkle proofs show it matches what they committed to earlier.
5. The referee re-computes **just that step** and sees who was right. This is about 100× cheaper than re-running everything.
6. This works as long as at least **one** of the nodes is honest.

**Adaptation for this project:** use one **pipeline stage** as the unit instead of every single math operation.
- Each node publishes hashes of its stage's input and output hidden states.
- On a dispute, the referee re-runs just that one stage.
- This is the brief's "per-stage checks", now with a proven method behind it.

**Source:** Verde, Gensyn (arXiv 2502.19405)

---

### Problem 13: Different GPUs give slightly different answers (the biggest open problem)

**What.**
- Problems 11 and 12 compare **hashes**, so they need bit-for-bit identical outputs.
- But an RTX 3050 and an RTX 4060 running the same model on the same input give *slightly* different numbers.

**Why.**
- Floating-point addition depends on order: (a+b)+c can differ from a+(b+c) in the last digits.
- Different GPUs, drivers, and settings add things up in different orders.
- Tiny differences change the hash completely.
- Result: an honest node can look like a cheater. That is a **false accusation**, and slashing an honest person kills trust in the system.

**How (options).**
1. **RepOps (from Verde)**: rewrite the math so additions always happen in a fixed order on every GPU.
   - Gives exact results.
   - But it only works for 32-bit math on NVIDIA CUDA with a single GPU.
   - It makes inference **58–218% slower**.
   - **Does not fit** llama.cpp 4-bit models on mixed laptops.
2. **Same-hardware verifier**: send the re-check to a node with the **same GPU model** and settings, then compare hashes. Works when there are enough nodes of each GPU type.
3. **Tolerance compare**: instead of hashes, compare the top few **logprobs** and allow a small, measured difference.
   - Measure the normal difference for each pair of GPU types in advance (calibration).
   - A smaller or more heavily compressed model differs by much more than that, so it still gets caught.

**Decision:** choose option 2 or 3. The brief currently mixes hash receipts with tolerance calibration, and those do not work together. **Option 3 is the most realistic for laptops.**

**Source:**
- Verde / RepOps (arXiv 2502.19405)
- PoSP's determinism assumption (arXiv 2405.00295)

---

## Part 5: Where the brief describes a paper wrongly

Fix these before quoting the papers to judges.

| Paper | Brief says | What the paper actually shows |
|---|---|---|
| **Dovetail** | Speculative decoding on mixed hardware, 1.8–10× for 13B on consumer GPUs | "Mixed" means CPU + GPU in **one computer**. The big model checks on the CPU, the draft runs on the GPU. No network or multi-machine tests. About 2.35× average on its main test machine. |
| **Parallax** | Better speed on real volunteer nodes | 7 high-end GPUs (5× RTX 5090, 2× RTX 4090) in **data centers**. Compared against only one other system (HexGen). No mid-request crash recovery, no cheating checks. Up to 3.6× throughput (1.58× average). Code: GradientHQ/parallax on GitHub. |
| **FusionAI** | 50 RTX 3080s match 4 H100s | A **rough estimate on paper** from operation counts for BERT-Large, a small older model. Not measured, and not LLM chat inference. Do not quote it. |
| **Berkeley report** | Heuristic scheduler for mixed hardware | Correct. Author Elden Ren, advisor Dawn Song. Tests are **simulated** from RTX 3090 measurements. Useful number: a 70B model reached 175 ms per token (about 5.7 tok/s) on RTX 3090s. A 3090 has 24 GB and about 936 GB/s, much stronger than a laptop GPU, so the brief's 4–6 tok/s for 70B on laptops is optimistic. |
| **Petals** | BLOOM-176B at about 1 step per second | Correct in the lab. Over the real internet: 0.83 steps/s. Also: 8 users at once slowed each one by only about 20%, which supports "more users = more total output". That needs Petals-style per-session pipelining, which stock llama.cpp RPC does not do. |

---

## Part 6: What to build first

1. **Layer placement**: water-filling + contiguous ranges (Problem 1)
2. **Routing**: (layer, laptop) graph + DP, chain pinned per request (Problem 2)
3. **Crash recovery**: coordinator saves inputs and replays them to a replacement (Problem 5)
4. **Privacy**: embedding layer stays on the coordinator (Problem 9)
5. **Node health**: heartbeats, backup pool, desktops vs laptops (Problem 6) + TTL metrics table (Problem 4)
6. **Join / leave / rebalance rules** (Problem 3)
7. **Check rate**: set from the PoSP formula (Problem 11)
8. **Stage-level commitments**: Merkle root of stage input/output hashes (Problem 12)
9. **Decide the verification mode** before writing verifier code: same-hardware hash or logprob tolerance (Problem 13)

---

## Sources

| # | Paper | Link |
|---|---|---|
| 1 | Petals: Collaborative Inference and Fine-tuning of Large Models (Borzunov et al., 2022) | https://arxiv.org/abs/2209.01188 |
| 2 | FusionAI: Decentralized Training and Deploying LLMs with Massive Consumer-Level GPUs (Tang et al., 2023) | https://arxiv.org/abs/2309.01172 |
| 3 | Task Scheduling for Decentralized LLM Serving in Heterogeneous Networks (Ren, UC Berkeley EECS-2024-111) | https://www2.eecs.berkeley.edu/Pubs/TechRpts/2024/EECS-2024-111.html |
| 4 | Parallax: Efficient LLM Inference Service over Decentralized Environment (Gradient, HKUST, NUS, 2025) | https://arxiv.org/abs/2509.26182 |
| 5 | Dovetail: A CPU/GPU Heterogeneous Speculative Decoding for LLM Inference (EMNLP 2025) | https://arxiv.org/abs/2412.18934 |
| 6 | Proof of Sampling: A Nash Equilibrium-Secured Verification Protocol for Decentralized Systems (Hyperbolic, 2024) | https://arxiv.org/abs/2405.00295 |
| 7 | Verde: Verification via Refereed Delegation for Machine Learning Programs (Gensyn, 2025) | https://arxiv.org/abs/2502.19405 |
| 8 | llama.cpp RPC README (connection direction, security warning, `-c` cache) | https://github.com/ggml-org/llama.cpp/blob/master/tools/rpc/README.md |
