# Parallax: Node Join, Leave, Redistribution, and Mid-Request Failure

Source: our tests on 5–6 Nov 2026 (RTX 4060 laptop + M4 MacBook Air, Qwen3-8B / Qwen3-14B) and the Parallax source code (GradientHQ/parallax, commit `162354a`).

---

## 1. Joining

| Situation | What Parallax does |
|---|---|
| **Before the pool starts** | The scheduler waits for the expected number of nodes (`-n`). Then it places layers once for everyone, e.g. Mac `[0, 29)`, 4060 `[29, 40)`. |
| **After the pool is running** | With the default routing mode (`rr`, round-robin over fixed pipelines), a new node waits as **standby** until it can form or complete an extra full copy of the model ("[RR] Added 1 new pipeline…"). It does **not** take layers away from existing nodes to speed them up. |
| **Joining slowly** | A node that waits **more than 30 s for its assignment** is dropped the moment placement runs. The scheduler sets its heartbeat timestamp once, at join, and the node only starts sending heartbeats after it receives its layers. |
| **Waiting too long** | A node gives up after **5 minutes** without an assignment (`launch.py`, `max_wait_time = 300`). |

---

## 2. Leaving and redistribution

| Situation | What Parallax does |
|---|---|
| **Detecting a departure** | Only via **heartbeat timeout (30 s)**. |
| **Layers still covered** (spare copies exist) | The node is removed and the other copies keep serving. No redistribution. |
| **Layers now uncovered** | **Global rebalance:** every node goes to standby, placement runs from scratch, and **all nodes get new layer ranges and reload weights**. The whole pool is down during this, not just the missing part. |
| **Not enough memory left** | "Insufficient resources": the pool stops serving until enough nodes come back. We saw this every time the Mac dropped. |
| **Speed of redistribution** | Each node loads **only its assigned layers** from local disk. Fast if the full model is already downloaded; slow if it must download first (the Mac's link filled up). |
| **Reliability of reassignment** | Fragile in our tests. After a re-placement, the Mac's handoff went to a stale peer and requests hung until a clean restart of both sides. |

---

## 3. A node leaving mid-request

**Parallax does not recover the request.**

- The request is part-way through the pipeline. The leaving node held **its share of the conversation memory (KV cache)**, and that is lost.
- The stream breaks or hangs. We saw `503 "Failed to establish connection to peer"` and a 180 s forwarding timeout.
- **Retries happen only before forwarding starts:** the request handler retries routing up to 20 times and forwarding up to 10 times (5 s apart). Once the request is running, nothing retries.
- There is **no replay** of saved stage inputs to a replacement node (the Petals technique).

---

## 4. What we add on top

| Gap | Our fix |
|---|---|
| Mid-request failure | **Gateway L1 failover:** resend the prompt plus the partial answer to another pool and stitch the stream. The user sees a ~1–3 s pause instead of a failed request. |
| Slow detection (30 s heartbeat) | The gateway detects **stalls in the stream (> 5 s)** directly, much faster than heartbeats. |
| Slow joiners dropped | Launcher hook: **refresh heartbeat timestamps at placement**, or skip the timeout for nodes still waiting for layers. Removes the need for synchronized joins. |
| Whole-pool reload on one departure | Keep **spare copies** of layers when the pool has room, so most departures do not uncover layers. Add a **cool-down** before any global rebalance. |
| Fragile reassignments | After any re-placement, the coordinator **restarts members cleanly** (whole process group) instead of trusting live reassignment. |
| Coordinator leaving | The gateway picks the next most reliable member as the new coordinator; members rejoin it with weights already on disk. |
| Slow reloads | The node agent **keeps the full model on disk** before joining. |
| Leftover ("ghost") processes | Always stop the **whole process group** of a node; reject heartbeat-only joins that carry no hardware details. |

---

## 5. Summary

Parallax handles joining and leaving at the **planning** level (who holds which layers), but not at the **serving** level:

- departures cause pauses;
- sometimes they cause a full-pool reload;
- a departure mid-reply always fails that request.

Covering this gap with gateway failover and the launcher fixes is one of the clearest engineering contributions we can show judges.
