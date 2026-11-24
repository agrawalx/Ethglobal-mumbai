# GPU Pool | Can a campus share its laptops to run local AI?

**Founder decision brief · 24 November 2026**

**Fund a pilot in one supervised campus lab. Defer the public marketplace.** A small group of nearby laptops can run a model that exceeds the usable memory of one device. This project has already done that over Ethernet. The business depends on three further results. A larger model must solve a task better. Enough owners must supply their laptops at the same time. A buyer must pay enough to cover support and service costs.

Start with a scheduled lab session for a programming course. Give the instructor a known model, a fixed budget and a list of approved machines. Let students earn credits for work that other students use. Begin with public exercises. Admit a second campus only after the first one pays to continue.

### What the evidence supports

| Founder question | Answer today | Decision |
|---|---|---|
| Can three laptops serve one chat? | Yes. Five wired runs reached a median of 7.92 output tokens per second on Qwen3-14B. | Use this setup as the reference. |
| Can a busy campus use Wi-Fi? | The expected traffic for a short answer is small. A long prompt can send tens of megabytes between workers. Delay and shared airtime matter. | Admit a wireless pool only after a test during class hours. |
| Can it run a much larger model? | Published work ran a 70B model on home devices. One reported result was about 1.5 tokens per second. | Offer larger models for queued work if users accept the wait. |
| Can a stranger safely process a private prompt? | The gateway handles the prompt. The pinned worker protocol also forwards input token IDs. The prototype disables output verification. | Restrict early jobs to approved operators and public data. |
| Who will pay? | The project shows a working service and test payments. There is no paid renewal or buyer interview in the evidence reviewed here. | Test a departmental service fee against a hosted API and a lab workstation. |

Sources for these findings appear with the analysis below. Project measurements come from the repository at commit `35c70d8`. No new hardware trial or buyer survey was part of this study.

## 1. Follow one request

A **token** is a piece of text. A **model weight** is a stored number that the model uses to calculate its answer. A **worker** is a computer that runs part of the model. A **pool** is a group of workers that can serve the complete model.

1. A provider agrees to a time window. The coordinator checks its device and assigns it a group of consecutive model layers. Each layer performs one part of the calculation.
2. The workers load their weights. The pool lists the model and its available capacity. A heartbeat tells the gateway that each worker is still present.
3. A requester sends a prompt to the gateway. The gateway reserves credits and selects a ready pool. The pool coordinator manages the workers.
4. The workers process the prompt. This step is **prefill**. Each worker passes intermediate numbers to the next worker. The weights stay in place.
5. The model generates one token. This step repeats for each new token. This is **decode**. The gateway streams the answer and settles the charge.
6. The providers can spend earned credits on later requests. One pool can serve many requesters over time. A marketplace can route whole requests to other pools. Keep the links between model layers inside each local pool.

The prototype uses Parallax for model execution. It already has a pool directory, a gateway compatible with the OpenAI chat API, and a credit ledger. The product opportunity is to operate this system reliably for a buyer. Model splitting alone is available in other software. [Project overview](../../README.md) · [System specification](../SPEC.md) · [Parallax](https://github.com/GradientHQ/parallax) · [EXO](https://github.com/exo-explore/exo)

## 2. Read the speed figures in context

| Source and setup | Result | What it tells the buyer |
|---|---|---|
| Project. M4 and RTX 4060. Qwen3-14B, mixed 8-bit formats. | The team reduced memory pressure. Decode rose from 3.2 to 5.2–6.0 tokens/s. The first token took 0.65–1.2 s after tuning. | Free memory for the operating system and the request cache before adding another worker. [Engineering handoff](../HANDOFF.md) |
| Project. M4, M5 and RTX 4060. Qwen3-14B over Ethernet. | Five of five runs succeeded. Median decode was 7.92 tokens/s. Median time to first token was 0.43 s. Later logs show 7.49 and 8.05 tokens/s. | At 7.92 tokens/s, a 256-token answer takes about 33 s including the reported first-token delay. A second student can wait most of that time if requests run in sequence. [Live run record](../LIVE-DEMO-RUNBOOK.md) |
| Project. One RTX 4060. Qwen2.5-7B, 4-bit format. | 53.5 output tokens/s. Prompt processing reached 2,596 tokens/s. | A smaller local model is a serious alternative. The two speed figures describe different operations. The models also differ. [Engineering handoff](../HANDOFF.md) |
| Petals study. Llama 2 70B. Three T4 GPUs, one client, 128-token sequence. | At low delay, decode reached 2.29 steps/s at both 100 Mbit/s and 1 Gbit/s. At 100 Mbit/s and 100 ms round-trip delay, it fell to 1.57. | Low delay can matter more than extra bandwidth during decode. The researchers controlled these network conditions. Campus laptops need their own test. [Borzunov et al., Table 2](https://arxiv.org/html/2312.08361v1) |
| Prima.cpp study. Mixed home hardware with limited memory. | A 70B model took 674 ms/token, about 1.48 tokens/s. A separate 32B test reached 26 tokens/s with speculative decoding. | The second method checks several candidate tokens at once. Its gain depends on how often the target model accepts them. Neither result predicts Parallax speed. [Li et al., methods and experiments](https://arxiv.org/pdf/2504.08791) |

At 1.48 tokens/s, a 256-token answer takes almost three minutes. At 8 tokens/s it takes about half a minute. Ask the instructor which tasks can wait. Count successful tasks per class hour. A high total token rate across a class can still give each student a slow answer.

### Memory and answer quality

Four-bit weights for a dense 32-billion-parameter model require about 16 GB before overhead. A 70-billion-parameter model requires about 35 GB at the same precision. Add the quantization tables, runtime buffers, display use, operating system and request cache. Check each worker separately. A pool fails if one assigned stage exceeds its device budget. Ordinary system RAM on a gaming laptop can hold weights, but moving them into GPU memory can slow each token. Apple unified memory also serves the operating system and other applications.

For Qwen3-14B, a two-byte key and value cache uses about 640 MiB for one 4,096-token sequence across all 40 layers. The calculation is 2 arrays × 40 layers × 8 key/value heads × 128 values × 2 bytes × 4,096. Four such sequences require about 2.5 GiB before allocator overhead. Check the actual cache format and allocation on both backends. The model configuration permits longer inputs than the project's tested Mac launch setting. [Qwen model configuration](https://huggingface.co/Qwen/Qwen3-14B/raw/main/config.json) · [Project launch limits](../HANDOFF.md)

For one dense decode stream, a first estimate of time per token is the sum of stage times and transfer delays. Estimate each stage time from weight bytes divided by sustained memory read speed. Then measure it. Compute, cache reads, format conversion and scheduling can raise that time. A second stream can use a stage while the first stream uses the next one. This can raise total output. The project's post-tuning batching rate remains an open measurement. [Batching run record](../LIVE-DEMO-RUNBOOK.md)

Use a local 7B or 8B model, the pooled 14B model and a hosted alternative on the same 100 public course problems. Include code repair, explanation and course terminology. Keep prompts, output limits and sampling settings fixed. Hide the model names. Run code against instructor tests. Have two reviewers score explanations against the same rubric. Record disagreement and the number of problems each model alone solved. Test 4-bit and 8-bit variants where they fit. Count any answer that exceeds the class time limit as a failure. Buy more capacity only if students get more correct answers in the time available.

### Would three Macs beat two Macs and an NVIDIA laptop?

**The available measurements do not establish a winner.** The wired project result covers an M4, an M5 and an RTX 4060. Replacing the RTX changes its layer speed, available memory and communication path at the same time. Linux is the operating system. The relevant execution difference here is between MLX on Apple silicon and CUDA on the NVIDIA GPU. Two Macs can also differ greatly in memory bandwidth and sustained performance. [Project run record](../LIVE-DEMO-RUNBOOK.md)

The installer pins Parallax at revision `162354a`. Each worker loads weights for its own backend. During generation, Parallax sends intermediate arrays between stages. Its sender writes the array in the safetensors format. A CUDA sender first copies a GPU tensor into host memory. A CUDA receiver loads the bytes and moves the tensor to its device. The MLX path writes to and reads from a memory buffer. Both paths serialize the array. The code here does not convert the complete model or require a change of numeric precision at every mixed boundary. Device synchronization, copies, packing and queue delay can still cost time. Source inspection identifies these operations. It supplies no duration for them. [Pinned installer](../../pool/bootstrap/host.py) · [Parallax sender and receiver](https://github.com/GradientHQ/parallax/blob/162354a03234a28cf6e2946e2e0b2203da7c3721/src/parallax/p2p/message_util.py#L202)

Apple measured Qwen 3.8 27B on M5 Ultra Mac Studios. One machine produced 19.69 tokens/s. Two machines with consecutive layer groups produced 19.44. The same pair reached 33.27 when both machines computed parts of each layer together. That second method used MLX tensor parallelism and direct memory access over Thunderbolt. These are desktop results with a different runtime path. They show why the model, link and method must accompany every claim about adding a Mac. In a separate study, Prima.cpp selected workers and layers using device and link costs. This approach also suits a campus with different laptops. [Apple MLX study, Table 3](https://machinelearning.apple.com/research/mlx-distributed-inference) · [Prima.cpp, sections 3–4](https://arxiv.org/pdf/2504.08791)

### Which laptops should run which model?

Use the following candidates for the first lab. The counts refer to **serving workers**. A coordinator that only routes requests adds no model memory. Use existing hardware for this comparison. Record the exact chip, GPU memory, unified memory, laptop power limit and sustained clock rate. An “M4” or “RTX” label alone cannot predict the result.

| Model and job | First configuration to try | Reason and evidence |
|---|---|---|
| Qwen2.5-7B at 4 bits, short interactive answers | One RTX 4060 laptop with 8 GB of GPU memory. Also test one 16 GB M4 or M5 with a compatible 4-bit model. | The project recorded 53.5 tokens/s on the RTX with llama.cpp. Use it as a single-device reference. For several users, try independent model copies before splitting this model. The Mac comparison still needs measurement. |
| Qwen3-14B at about 8 bits, individual chat | Start with the measured M4 plus RTX pair. Compare the measured M4 + M5 + RTX topology against M4 + M5 + a third 16 GB Mac. Include one 24 or 32 GB Mac if the full model and cache fit. | The wired mixed trio is the best documented reference here. The pair reached 5.2–6.0 tokens/s under its recorded settings. Neither prior run controls for every hardware difference. A larger single Mac removes worker hops. |
| Qwen3-30B-A3B-Instruct-2507 at about 8 bits, larger-model trial | Try four 16 GB Macs if measured shard budgets fit. Compare four Macs plus one 8 GB RTX. Include one 48 or 64 GB Mac if available and supported. | The handoff estimates 32.5 GB for the MLX snapshot, 8–8.5 GB of safe weight space per small Mac and about 5 GB on the RTX. Four small Macs are marginal at 32–34 GB. Four plus the RTX give roughly 37–39 GB before placement constraints. Test the actual layer map. About 3.3B parameters are active per token, but all experts need storage. |
| Dense 70B at 4 bits, queued work | Start with one compatible 64 GB Mac or two 32 GB Macs. With only 16 GB Macs and an assumed 8 GB weight budget each, start fit tests at five. | The raw weight floor is 35 GB. Five small workers provide only about 40 GB under this assumption. Metadata, uneven layers and endpoint weights can exhaust this margin. Check backend support before downloading. Test whether the answer deadline allows this configuration. |

The 30B handoff's 15–25 tokens/s is a target. It has no measured result in the cited run record. A successful load establishes capacity. A timed run with the requested context and answer quality establishes a usable service. A 4-bit alternative can reduce the worker count. Record its quality and identify its runtime as a separate configuration. [Engineering measurements](../HANDOFF.md) · [30B model plan and weight budgets](../MOE-30B-HANDOFF.md) · [Run record](../LIVE-DEMO-RUNBOOK.md)

### Assign the layers and measure efficiency

1. Reserve memory for the operating system, applications, runtime buffers and the cache at the promised context and concurrency. Measure free GPU memory on CUDA. Measure memory pressure and swap on each Mac. Reserve extra space for the first and last stages, which handle input and output.
2. Measure each device on representative contiguous layers with the intended format. Record milliseconds per layer separately for a short decode step and a long prefill. Measure the output stage separately. The final vocabulary projection can make two equal layer counts cost different amounts.
3. Fit complete routes with no missing layers. For one stream, add each stage time and each boundary time. For concurrent users, also check the busiest stage and queue. The pinned scheduler already supports contiguous allocation, endpoint reserves and routing by node delay and link delay. Calibrate these estimates with the measured workload. [Pinned scheduler design](https://github.com/GradientHQ/parallax/blob/162354a03234a28cf6e2946e2e0b2203da7c3721/src/scheduling/README.md)
4. Use a break-even test for a replacement. For example, if the RTX saves 12 ms of layer work but adds 5 ms of boundary cost, the mixed pool saves 7 ms per token. If it adds 18 ms, the all-Mac pool saves 6 ms. These numbers illustrate the decision. Measure both terms on the actual laptops.
5. For each route that meets the quality and latency limits, divide total wall watt-hours by correct tasks delivered. Include the coordinator, switch and idle time during booked hours. Report correct tasks per laptop-hour and total cost per correct task alongside energy. Prefer the lowest cost that meets the class deadline. Keep an extra laptop as a separate replica when that serves more users.

### Isolate the cost of a mixed boundary

Run two comparisons. First, keep the M4 and M5 in the same positions. Use the same wired switch, prompt IDs, layer ranges, model revision, output length and single-user load. Put either the third Mac or the RTX in the last position. Use the supported MLX and CUDA artifacts and record their hashes. This measures the practical effect of the substitution, including kernel differences. Then tune each route separately for its best service result. An all-MLX Thunderbolt run belongs in a separate test row.

Second, send synthetic arrays of the observed shape and type through the pinned send and receive functions. Test Mac → Mac, Mac → RTX and RTX → Mac. Include RTX → RTX if a second compatible laptop is available. Time device completion, packing, network transfer, unpacking and receiver readiness. Also time an equal-size byte payload on the same link. Synchronize asynchronous device work before interpreting a timer. Use a sender-side round trip for cross-machine comparisons unless the clocks have a verified common time base. Count complete message bytes. Repeat with one decode vector and prefill-sized arrays. Keep this instrumentation outside the timed end-to-end service runs.

Use the repetitions and thermal checks in section 3. Compare paired runs and report the spread of the differences. A small difference within run-to-run variation gives no sound basis for a buying decision. Publish each winning configuration with its model, precision, number of users, context, link, layer map, per-user tokens/s, first-token delay and watt-hours per correct task.

## 3. Choose the network by measurement

A pipeline sends a vector between adjacent stages. Assume one 5,120-value vector per token and two bytes per value. This gives 10,240 bytes per boundary. A three-stage pipeline has two boundaries. At eight output tokens/s each boundary carries about 0.66 Mbit/s of decode payload. A 2,048-token prompt carries 20 MiB per boundary. Model downloads, acknowledgments, protocol headers, the return path and retries add traffic. Confirm the actual representation and byte counts in Parallax. [Qwen model configuration](https://huggingface.co/Qwen/Qwen3-14B/raw/main/config.json)

The table gives **calculated transfer times per boundary**. Each rate is an assumed usable payload rate. These are test cases, not measurements of a network standard. The calculation divides payload bits by usable bits per second.

| Example path | Assumed usable rate | One decode vector | One 2,048-token prompt |
|---|---:|---:|---:|
| Busy Wi-Fi | 50 Mbit/s | 1.64 ms | 3.36 s |
| Quiet Wi-Fi | 300 Mbit/s | 0.27 ms | 0.56 s |
| Switched gigabit Ethernet | 900 Mbit/s | 0.09 ms | 0.19 s |
| Direct Thunderbolt network link | 5 Gbit/s | 0.016 ms | 0.034 s |

For two serial hops on busy Wi-Fi, the prompt payload alone takes about 6.7 s under these assumptions. Chunking can overlap transfers and computation. Two wireless clients on one access point also compete for airtime. An extra 10 ms of effective delay at each of two boundaries adds 20 ms per output token. A 125 ms decode step then takes 145 ms, or about 6.9 tokens/s. This example holds worker time fixed. Network delay usually changes waiting time. Timeouts, retries and truncated answers can also change task success.

Use a switch and Ethernet for the first lab. Ask campus IT whether wireless clients may connect directly. Measure during lectures and in an empty room. A nearby laptop behind client isolation cannot join the same pipeline through that network. Test IP over Thunderbolt first on a supported Mac pair. Record the cable, port, network interface and route. A fast Mac-to-Mac link leaves the Ethernet link to the RTX worker in the path. Check each mixed operating system pair before buying cables. Fine-grained tensor splitting requires frequent synchronization within layers. Test it only if measured link delay supports it. [Apple network setup](https://support.apple.com/en-uz/guide/mac-help/mchld53dd2f5/mac) · [Petals, network experiments](https://arxiv.org/html/2312.08361v1)

### Reproduce the comparison

1. Use the same three devices, power profiles, model revision, tokenizer, quantization and layer map for each network. Record available memory, runtime version and room temperature. Record the single-device baseline separately.
2. Measure payload rate in both directions on each adjacent link. Record idle and loaded round-trip delay, jitter, packet loss and retransmissions. Test simultaneous traffic on both boundaries. Verify the interface that carried the bytes.
3. Time model download, cached startup and the first cold request separately. Warm the pool. Use 128, 1,024 and 3,072 input tokens with 128 output tokens. Keep the total within the tested 4,096 limit.
4. Run one, two and four simultaneous users. Repeat each supported case at least 30 times in randomized blocks. Repeat peak-hour Wi-Fi on three days. Save failures, timeouts and raw timestamps. Report the sample count with each percentile.
5. Measure from the client. Report median and 95th-percentile queue time, first-token time and token gap. Report per-user decode rate, total delivered tokens per wall second and correct tasks per hour. Also record bytes per hop, wall energy, swap and temperature after one hour.
6. Let one owner leave during a request. Record the partial answer, charge, time to restore capacity and effect on other users. Repeat with a worker asleep before admission. Confirm the requester can cancel and the ledger settles once.

## 4. Decide what the service can protect

The proposed private pilot has one trust boundary. The institution approves the gateway, coordinator, devices and their operators. A prompt sent to the current central gateway leaves the student's laptop. A claim that data stays on campus requires a campus gateway and a check of every relay, log, backup and external service. A worker that handles intermediate numbers can learn about the prompt. Published split-inference experiments found recoverable prompt content even with early layers on a trusted device. [Project privacy design](../SPEC.md) · [Split-inference privacy study](https://arxiv.org/abs/2602.16760)

| Asset or failure | Pilot control | Evidence required before wider use |
|---|---|---|
| Prompt, answer and intermediate data | Use public exercises. Admit named operators. Authenticate and encrypt each network hop. Turn off transcript storage by default. Keep model data off public ledgers. | Trace a synthetic request through logs, backups and receipts. Verify retention, deletion and operator access. The spec permits plain transcript storage when the encryption key is absent. |
| Provider's laptop | Use a signed, pinned installer and verified weight files. Run a restricted worker account. Limit memory, disk and power. Give the owner a visible stop control and an uninstall path. | Demonstrate removal, key revocation and a clean stop. Seek IT approval before installation. Limit supported driver and OS versions. |
| Model identity and answer integrity | Pin model and tokenizer revisions. Submit known public test cases. Compare a sample with a trusted reference within a defined tolerance. Review mismatches before payment disputes. | Measure detection rate, false alarms and duplicate compute cost. A signed receipt identifies the signer. Correct computation still needs independent evidence. |
| Account, gateway and ledger | Limit key budgets. Keep signing keys at the gateway. Reserve credits before dispatch. Use one settlement per request ID. Reconcile receipts after restart. | Confirm a canceled, failed or retried job cannot cause two charges. Test restore from backup and revoke an operator during a session. |
| Unsafe content or unintended tool use | Publish allowed workloads and an abuse contact. Keep tool execution on the requester. Require user approval for actions with external effects. | Run course-specific safety cases and incident drills. Give the instructor a way to suspend a pool. |

The prototype disables output verification. Mixed numeric formats can produce different valid next tokens. Exact text matching across backends can therefore reject honest work. Sampling gives statistical evidence and leaves some errors undetected. Identity checks and signed heartbeats establish neither model correctness nor confidentiality. Keep sensitive jobs within managed hardware until an independent review supports the specific protection claim. [Project overview](../../README.md) · [Security and accounting specification](../SPEC.md)

**Treat all current stage operators as able to read the prompt.** In the pinned Parallax path, the executor puts original input token IDs into intermediate requests. The encoder copies those IDs into the forwarded message alongside the intermediate array. A worker with the tokenizer can decode these IDs. This is a stronger exposure than the risk from intermediate arrays alone. A private transport protects traffic in transit. An approved operator remains necessary at every receiving stage. Verify the deployed build with a synthetic prompt before making a campus privacy claim. Include the repeated token-ID field when measuring long-prompt traffic. [Pinned executor](https://github.com/GradientHQ/parallax/blob/162354a03234a28cf6e2946e2e0b2203da7c3721/src/parallax/server/executor/base_executor.py#L838) · [Pinned message encoder](https://github.com/GradientHQ/parallax/blob/162354a03234a28cf6e2946e2e0b2203da7c3721/src/parallax/p2p/message_util.py#L41)

For an Indian pilot, agree in writing who operates the service, who handles complaints, who can see prompts and who pays for electricity. Review the applicable commencement dates under India's personal data rules with counsel. Address student age, consent, deletion, incident handling and cross-border services before collecting personal data. Review model and runtime licenses for every distributed artifact. Check campus network terms, warranty, acceptable use and procurement. Keep a record of withdrawal and removal. Seek a separate review before transferable credits, cash payouts or public listings. [Government notification, commencement in rule 1](https://www.meity.gov.in/static/uploads/2025/11/53450e6e5dc0bfa85ebd78686cadad39.pdf) · [Qwen model and license](https://huggingface.co/Qwen/Qwen3-14B)

## 5. Design the exchange around work that people use

BitTorrent rewards cooperation through peer service decisions. Here the provider earns a balance for later use, possibly at a different campus and time. That creates a future service obligation. A student who supplies an hour today needs a credible answer to “What can I run tomorrow?” Show the balance, price per request, available model, expected wait and service hours before the user spends credits. [BitTorrent protocol, BEP 3](https://www.bittorrent.org/beps/bep_0003.html)

The prototype prices a request as model factor × (output tokens + 0.2 × input tokens). It assigns 90% of credits to serving nodes by layer count, burns 5% and puts 5% in reserve. The owner's share on a self-request goes to reserve. Starter grants and availability rewards also affect supply. Direct x402 payments use a separate testnet flow. Providers receive 80% of eligible payment income. In the live test, claim gas exceeded the example payout. Keep these two accounts separate in financial reports. [Credit specification](../SPEC.md) · [Live settlement record](../LIVE-DEMO-RUNBOOK.md)

**Proposed pilot policy.** Use nontransferable service credits. The course sponsor buys reserved hours. Set a fixed grant budget per course and show students when they can redeem credits. Pay for successful jobs with verified usage. Fund any reserved standby time from the sponsor's budget. Raw RAM, online minutes and self-reported speed can all overstate useful supply.

Publish a receipt with model revision, input and output counts, completed stages, amount held and final charge. Give providers a dispute window. Benchmark the cost of each stage. Layer count can overpay a slow or inexpensive stage and underpay a memory-heavy one. Simulate an alternative split on past jobs before changing rewards. Count provider time, energy and credits actually redeemed. Interview providers who stop.

Track grants, earned balances, spending, burn, reserve and outstanding credits weekly. Convert outstanding credits into expected service hours at observed model mix and throughput. Compare those hours with booked capacity. Stop issuing promotional credits when expected redemption exceeds the sponsor's funded hours. Review repeated reciprocal requests, duplicate identities and unusual grant use. Cap promotion losses. Preserve access for students who cannot contribute hardware.

## 6. Identify the buyer and the alternative

The first buyer hypothesis is a computer science department that already owns a teaching lab. A course lead supplies recurring exercises. Campus IT controls the network. A lab technician can keep at least one pool ready during a booked session. A student club can recruit volunteers, but a club's interest does not establish a departmental budget.

| Alternative | Why a buyer might choose it | Test for GPU Pool |
|---|---|---|
| One laptop with a smaller model | No coordinator or waiting for peers. The repo measured fast 7B output. | Does the larger model solve materially more course problems by the deadline? |
| One shared workstation | One operator, one failure point to manage, predictable class hours. | Compare a local purchase or rental quote including support, energy and depreciation. |
| Hosted inference API | Quick setup and capacity on demand. Together lists Qwen3.5 9B at USD 0.17 per million input tokens and USD 0.25 per million output tokens. | Compare cost per correct task, latency, data terms and quality on the same exercise set. The model differs. [Provider price list, checked 24 November 2026](https://www.together.ai/pricing) |
| Self-managed EXO or Parallax | A technical club can build a cluster itself. | Does the buyer pay for setup, scheduled availability, budgets, support and reports? [EXO](https://github.com/exo-explore/exo) · [Parallax](https://github.com/GradientHQ/parallax) |
| Distributed research networks | Petals demonstrates shared model capacity across owners. | Test whether local operators, predictable hours and course integration improve repeat use. [Petals experiments](https://arxiv.org/html/2312.08361v1) |

Start sales with a single lab and a named course. Ask ten instructors for their last four weeks of actual assignments, spend and failed workflows. Ask five IT leads who can approve installs and network access. Ask twenty students when they will lend a device, for how long and for what benefit. Request a paid trial with a start date. Track the time from first contact to approval, the staff hours per install and repeat use after starter credits run out.

Size the reachable business from the bottom up. For example, 40 reachable departments × 25% conversion × USD 200 per month × 8 teaching months gives USD 16,000 annual revenue. These are assumptions, with no signed customers behind them. Replace each assumption with a named prospect list, a recorded conversion rate and an actual price. This scenario could support a small pilot. A venture-scale case needs many more campuses, a higher-value buyer, or a much lower cost of acquisition. Test managed company labs next only if campus retention supports expansion.

A defensible advantage could come from measured placement data across devices, low support time and trusted campus distribution. Each new campus adds useful supply only when its devices form a complete pool during demand. Count ready pool-hours by model and trust policy. A global count of registered laptops can hide an empty marketplace.

## 7. Calculate the cost of a useful answer

The following example uses USD for comparison. Replace all assumptions with local meter readings, tariffs and receipts. Assume eight delivered output tokens/s while decoding, 120 W incremental pool power while active, 30 W while waiting, and USD 0.12/kWh. Assume the pool stays available for one hour. Utilization below means the fraction of that hour spent delivering output. Failed work and prefill reduce that fraction. The simple power model treats all other time as waiting. Measure those states separately in the pilot.

| Utilization | Output tokens per available hour | Electricity per hour | Electricity per million output tokens |
|---:|---:|---:|---:|
| 100% | 28,800 | USD 0.0144 | USD 0.50 |
| 50% | 14,400 | USD 0.0090 | USD 0.63 |
| 10% | 2,880 | USD 0.00468 | USD 1.63 |

At 50% use, 100 requests with 1,024 input and 128 output tokens each deliver 12,800 output tokens. The example allocates about USD 0.008 in electricity to that work. At the cited hosted 9B rates, the same token counts cost about USD 0.021. One minute of technician time at an assumed USD 12/hour costs USD 0.20. Even small support costs can dominate the apparent saving. Different tokenizers, answer quality and privacy terms can change the purchase decision.

For each site, calculate monthly contribution as collected fees minus provider compensation, power reimbursements, hosting, network, support, failed jobs, payment fees and hardware allowance. Avoid counting the same reimbursed electricity twice. Accrue the cost of future credit redemption. Separate donated energy from energy saved. Measure watt-hours per correct task against a single workstation before making an environmental claim.

At USD 200 per teaching month, an assumed USD 60 of site costs plus five support hours at USD 12 leaves USD 80 before sales, engineering and tax. Twelve support hours produce a USD 4 loss on the same assumptions. A sales visit costing USD 240 requires three profitable teaching months to recover at USD 80/month. Charge a setup fee or simplify deployment if renewals cannot cover acquisition. Ask the budget holder to choose between real quotes for reserved service, pay-per-use and a workstation.

### Engineering work before a second campus

| Failure the buyer will see | Required product behavior | Acceptance test |
|---|---|---|
| Two installations advertise the same model but use different tokenizers or layer layouts. | Maintain an approved manifest with model revision, backend artifact hashes, tokenizer, chat template, layer count and supported operations. Reject incompatible joins before listing capacity. | Substitute an incompatible revision in a test pool. Confirm that admission fails and existing jobs finish. |
| A model fits at startup and fails during class. | Reserve cache space for each admitted request, including its maximum output. Bound the queue. Update the available capacity when another application uses memory. | Combine long prompts, short chats and cancellations. Check memory, fairness, timeouts and release of cache slots. |
| A pool takes much of the booked session to start. | Cache approved artifacts in advance. Check free disk, checksums, driver compatibility and required kernels before the class. Retain the last working revision for rollback. | Restart with a warm cache and then with one missing shard. Time both paths. Publish the service as ready only after a full-route test request. |
| A laptop sleeps, changes network or slows down on battery. | Let owners set power and departure rules. Drain work before a planned exit. Expire stale routes. Assign new requests only to a complete pool. | Unplug one worker and close another lid in a supervised test. Record time to stop assigning requests, recover capacity and release charges. |
| A user receives half an answer or repeats an action after recovery. | Track request ID, delivered tokens, cancellation and settlement. Make a partial stream visible. Require explicit handling before replaying any client tool action. | Disconnect after the first token and after a tool request. Confirm a single settlement and no duplicate application action. |
| A software update changes speed or answer quality. | Version the scheduler measurements with hardware, model and driver. Keep privacy-safe timings for queue, prefill, each stage and delivery. Compare old and new builds on the same tasks. | Roll out to one test pool. Roll back if the quality score, first-token limit or wall energy crosses the agreed threshold. |

These are proposed release tests. The live record already documents stale workers, slow recovery and a stalled pool. The memory, model and stream tests extend that evidence to classroom conditions. [Live run record](../LIVE-DEMO-RUNBOOK.md) · [Onboarding design](../PROVIDER-ONBOARDING.md)

## 8. Run a pilot with a stop decision

The thresholds below are proposed investment criteria. They are not measured service levels. Agree on them with the buyer before the first session.

| When and owner | Test | Decision rule |
|---|---|---|
| Weeks 1–2. Founder and instructor. | Identify the course, budget owner, exercises, allowed data and competing quote. Obtain IT approval and a paid pilot order. | Stop recruitment if no buyer will commit money and class time. |
| Weeks 2–3. Systems lead. | Run the wired baseline and the network comparison. Publish hardware, raw timing data and failed runs. | For 128 input and 128 output tokens, require median decode ≥6 tokens/s per user and 95th-percentile first token ≤3 s with two users. List only links that pass. |
| Weeks 3–4. Instructor. | Blind-score the 100 tasks. Record quality and total time against local and hosted options. | Require at least ten additional correct, on-time tasks versus the best single student device. Show the buyer the hosted comparison before renewal. |
| Weeks 4–7. Lab operator. | Run four weekly sessions. Count all attempts, owner exits and periods without a ready pool. | Require ≥95% completed requests and ≥95% availability during booked hours. Refund every failed request. Keep a second ready pool if a class needs continuity. |
| Week 8. Founder and finance lead. | Review repeat use, credit redemption, support time and actual cash costs. Ask for a paid renewal. | Expand only with a renewal, positive site contribution and a second qualified buyer. Track whether at least half the first week's users return in the final week. |

When a worker left during the recorded demo, the request failed with zero charge. The pool served again 139 seconds after rejoin with runtime hooks. If three required workers were each ready 90% of the time, independent availability would give only 0.9³, or 72.9%, for the complete route. Class schedules can make failures correlated. Measure joint availability directly. Let owners publish departure times. Drain their requests before they leave. Route new requests to a ready replica with the same model and trust policy. Obtain consent before sending data to another site. [Recorded recovery](../LIVE-DEMO-RUNBOOK.md)

If Wi-Fi fails and wired service passes, sell scheduled wired sessions. If chat fails the latency test but batch jobs meet the deadline, test overnight evaluation with a named buyer. If the small local model solves the same tasks, offer single-device service where it fits and test whether shared administration has value. If the buyer declines renewal or measured costs exceed revenue, stop expansion. Revisit the public marketplace only after independent sites can fill requests, settle credits and resolve disputes at a measured cost.

**Decision at this review.** The founders have evidence for a working local pool. The next investment should buy a paid class session, a comparison against one good laptop, and a repeatable network measurement. Those three results determine whether the business has something worth scaling.
