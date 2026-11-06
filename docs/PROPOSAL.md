# GPU Pool Network: Project Proposal

**Event:** ETHGlobal Mumbai 2026
**Targets:** Finalist, Hedera track, World track, Arkiv track
**Writing standard:** ASD-STE100 (Simplified Technical English)

---

## 1. Summary

Many people have computers with good GPUs. These GPUs are idle for most of the day. One computer cannot run a large AI model. Our network connects near computers into pools. A pool runs models that no single computer can run.

Anyone can bring a node. A node joins a pool automatically when the delay to other nodes is low. Providers earn credits when they serve requests. They spend these credits on their own requests. People without credits pay per request with x402.

We tested this network. A 16 GB MacBook Air and an 8 GB gaming laptop ran a 14B model together. Neither machine can run this model alone.

---

## 2. The problem

1. Most consumer GPUs are idle. Their owners get no value from them.
2. One computer has a small memory. It can run only small models (about 8B parameters).
3. Cloud AI is expensive. It also sends private data to a third party.
4. Current networks do not include most consumer computers:
   - Darkbloom accepts only Apple computers. Each computer must have at least 36 GB of memory. It does not join computers together.
   - Parallax joins computers together, but only for trusted friends. It has no identity check, no verification, and no payments.
5. Open networks attract cheaters. In 2024, an attacker added 1.8 million fake GPUs to io.net.

---

## 3. The solution

### 3.1 Two units: the node and the pool

| Unit | Definition | Function |
|---|---|---|
| **Node** | One computer with one owner | Identity, credits, verification, blame |
| **Pool** | A group of nodes with low delay between them (less than 5 ms) | Runs one model together |

- Nodes form a pool automatically. The network measures the delay between nodes.
- One node alone is also a pool. It runs a small model on its own.
- Each pool has one coordinator. The coordinator is the most reliable node in the pool.
- A gateway sends each request to the best pool for the requested model.

### 3.2 Benefits of pooling

1. **Larger models.** The pool memory is the sum of the node memories. Two small computers can run a large model.
2. **All hardware types.** NVIDIA laptops and Apple computers work in the same pool.
3. **No minimum memory.** A 16 GB Mac and an 8 GB laptop can join. Darkbloom rejects both.
4. **Less cost.** The pool uses hardware that people already have.
5. **Better use.** Idle GPUs do useful work. Spare capacity also does verification work.

---

## 4. The incentive mechanism

Our mechanism is similar to the share ratio on a private BitTorrent tracker. Providers who give more compute get more priority.

### 4.1 Who pays

| Payer | Pays with | Method |
|---|---|---|
| **Provider** | Credits that the provider earned | The gateway removes credits for each request. |
| **New verified human** | Starter credits (one time only) | A World ID verification gives starter credits. These credits expire after 14 days. |
| **User without credits** (a human or an AI agent) | x402 (HBAR or USDC) | The user pays a fixed price for each request before the request starts. |
| **Network reserve** | Reserve credits | The reserve pays the nodes that do verification work. |

### 4.2 The cost of a request

- 1 credit is equal to 1 output token on an 8B model.
- Cost = model factor × (output tokens + 0.2 × input tokens).
- The model factor is related to the size of the model in memory. A 14B model at 8 bits has a factor of about 1.75.
- At the start of a request, the gateway holds the maximum cost. At the end, the gateway removes the actual cost.

### 4.3 How the payment is divided

1. 90% of the cost goes to the nodes that served the request. Each node gets a share that is equal to its share of the model layers.
2. 10% is a fee. Half of the fee is burned. Half goes to the network reserve.
3. An x402 payment goes to the network treasury. At the end of each period, most of it goes to the providers as credits.

### 4.4 Rules against abuse

| Problem | Rule |
|---|---|
| **A user sends requests to their own node** | A node gets no credits for a request from its own owner. |
| **Two users send requests to each other** | The fee on each transfer makes this cost credits. The network marks repeated flows between the same pair. |
| **Users keep too many credits** | Credits expire after some weeks. |
| **A node stops during a request** | The gateway sends the request to a different pool. The network finds the stage that stopped. Only that node loses credits for that part. |
| **A node does fake work** | The verifier finds it. The node loses its credits for that period. Its owner is blocked. |
| **A node claims a GPU that it does not have** | The network pays only for verified work. It never pays for claimed hardware. |

### 4.5 Priority

- All requests use one queue.
- A provider with a high contribution ratio gets a higher position in the queue.
- A low ratio does not block access.

---

## 5. Verification

Verification is cheap because a check is faster than generation.

1. A provider generates tokens one at a time. This is slow.
2. A verifier reads the prompt and the answer in one pass. This is fast.
3. The verifier calculates the probability of each token in the answer. A wrong model gives tokens with a low probability.
4. Idle pools with the same model do the verification. The verifier always has a different owner from the provider.

**Process:**
1. The network sends test prompts. These prompts look the same as real prompts.
2. The network also checks a small sample of real requests.
3. If a check fails, a second verifier does the check again.
4. If the second check also fails, a reference node makes the decision.
5. The network does not apply a penalty after only one failure.
6. The network also tests the verifiers with prompts that have known answers.

**Capability test:** The network sends a random input to a node. The node must send the correct output in a time that agrees with its hardware. This test finds nodes that claim hardware that they do not have.

---

## 6. Problems that the sponsors solve

Each sponsor solves one real problem. We do not use a sponsor only for a prize.

### 6.1 World: one human, one account

- **Problem:** One person can make many accounts. Each account gets starter credits. One person can also add many fake nodes.
- **Solution:** World ID proves that each account belongs to one unique human.
- **Use:** A node owner verifies with World ID before the node can join. A new user verifies before the user gets starter credits.
- **Result:** A blocked user cannot make a new account. Starter credits go to real humans only.
- **Credential:** We use the minimum credential that is sufficient. All credentials work on a phone. We do not use the Orb, because it needs a physical visit.
  - Selfie Check gives one node.
  - A good history of verified work gives up to three nodes.
  - Passport verification (NFC) gives up to five nodes. This is optional.

### 6.2 Hedera: a ledger that nobody can change

- **Problem:** Credits must be correct. Disputes need a record that the operator cannot change. Users and AI agents must pay without an account.
- **Solution:**
  - **HCS (Hedera Consensus Service)** keeps an ordered record of each credit transfer.
  - **x402** lets users and AI agents pay for each request. They do not need an account or an API key.
  - **Smart contracts** keep the node registry and the payout rules.
- **Result:** Each user can check the credit history. Money from x402 goes to the providers.

### 6.3 Arkiv: the public tracker

- **Problem:** Users must see which nodes and pools are available now. The operator must not be able to show false capacity. io.net showed GPUs that did not exist.
- **Solution:** Each node writes its own listing to Arkiv. The node owner signs the listing. The listing has an expiry time. The node extends the expiry with each heartbeat.
- **Result:** When a node stops, its listing disappears automatically. Nobody can show fake capacity. Arkiv also keeps the contribution ratios, the verification results, and the pool list.
- **Swarm:** The full record of each period goes to Swarm. Anyone can download it and check a dispute.

---

## 7. Engineering problems we solved

We tested the network on real hardware. These results are measured.

| Problem | Result |
|---|---|
| Run one model on an NVIDIA laptop and a Mac together | **Done.** Qwen3-14B on an M4 MacBook Air (16 GB, layers 0–28) and an RTX 4060 laptop (8 GB, layers 29–39). |
| Speed | **About 6 tokens per second**, with the first token in about 1 second. |
| Memory pressure on 16 GB Macs | We found that macOS moved memory to disk during inference. A smaller KV cache decreased swap-in by 88%. Speed increased by 85%. |
| Strangers join the pool on a shared network | Parallax uses one default network name for all users. We use a private name and an identity check. |
| Old processes act as "ghost" nodes | We stop the full process group each time. |
| A node that waits more than 30 seconds is removed | We found the cause in the Parallax source code. Our launcher gives a grace time. |
| A model download fills the network link | The node downloads the model before it joins the pool. |
| Logprobs are not available for verification | We use token-based verification (Token-DiFR) with a reference model. |
| Network address changes | The node restarts its connection when its address changes. |

---

## 8. Why this project can be a finalist

1. **It works on real hardware.** We show a live model that no single computer can run.
2. **It solves a real problem.** People get access to large AI models without a cloud bill.
3. **It includes more people.** It accepts small Macs and gaming laptops.
4. **It is fair.** Each human has one account. Cheaters lose their credits.
5. **The sponsors are necessary.** Without World, Hedera, and Arkiv, the network is not safe for strangers.

---

## 9. Demo plan

1. A user verifies with World ID. The user gets starter credits. A second account from the same human is rejected.
2. Two computers with low delay become one pool automatically. Arkiv shows the new pool.
3. The user asks a 14B model a question. The screen shows the route: Mac (layers 0–28), then gaming laptop (layers 29–39).
4. The credit transfer goes to HCS. The ratio dashboard shows the change.
5. An AI agent pays with x402. HashScan shows the payment. The providers get credits.
6. A node does fake work. The verifier finds it. The node loses its credits. Its listing changes on Arkiv.
7. We disconnect one computer. Its listing disappears from Arkiv after the expiry time.

---

## 10. Sponsor tracks

| Sponsor | Track | Requirement | Our feature |
|---|---|---|---|
| Hedera | AI Agents That Pay: x402 on Hedera | An agent pays for a request with no human approval | AI agents pay for each request with x402. HCS keeps the credit ledger. |
| World | Best Use of IDKit | Use the minimum credential for a real trust moment. Show a success path and a failure path. | One human, one account. A second account is rejected. |
| Arkiv | Build on Arkiv | Data lives in Arkiv. A visible feature reads it. | The public tracker: nodes, pools, ratios, and verification results. |

---

## 11. Risks

| Risk | Mitigation |
|---|---|
| The venue network is not stable | We use wired connections. We download all models before the demo. |
| A 16 GB Mac has little free memory | We use a small KV cache. We close other applications. We can add a third node. |
| Low demand makes credits less useful | x402 payments bring demand. They go to providers. |
| The pool coordinator can make false records | The gateway compares the coordinator records with reports from each node. |
| Pooled inference gives less privacy than Darkbloom | We do not claim the same privacy. It is a future item. |
