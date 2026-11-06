# Section 16 report: before and after

This report explains, in simple words, what changed for the items in `docs/SPEC.md` section 16
("out of scope for the MVP"). Date: 6 Nov 2026. Branch: `backendXoutofscope`.

**Big rule we kept:** everything is built on top of the MVP. We did not replace any MVP part.
Parallax is still installed as it is (we never changed its files). The gateway, SQLite + HCS ledger,
World ID, credits, x402, Arkiv and the router rule all stay the same.

**Important:** "Done" below means the code is written and the tests pass on this laptop.
Nothing here has been tried on the real 3-computer pool yet.

---

## Summary

| Part of section 16 | Before | After |
|---|---|---|
| 16.1 Inference and pools (15 items) | 0 done | 13 done, 1 partly done (WAN), 1 cannot be done without changing Parallax (speculative decoding) |
| 16.2 Verification (4 items) | not started | not started |
| 16.3 Incentives and reputation (10 items) | not started | not started |
| 16.4 Hedera and Arkiv (8 items) | not started | not started |

Tests now: gateway 99, shared 43, Arkiv 10, node agent 20, Parallax hooks 11, contract 17. All pass.

---

## 16.1 Inference and pools, item by item

### 1. Fault tolerance (a computer stops in the middle of an answer)
- **Before:** the answer broke. The user got an error after up to 3 minutes.
- **After:** the gateway tries once more. If some words were already sent, the new try continues
  the same answer. The user sees one answer with a short pause. The user pays only once.
- **Still missing:** fixing the problem inside Parallax itself (that needs Parallax changes).

### 2. Stall detection (the answer stops coming)
- **Before:** Parallax waited 30 seconds to notice a dead computer, sometimes 180 seconds.
- **After:** the gateway notices in about 5 seconds and starts the next try.
- **Still missing:** knowing exactly which computer stopped. We only note computers that were late.

### 3. Computers joining and leaving while the pool runs
- **Before:** when one computer left, Parallax reloaded the model on **every** computer at once.
- **After:** we wait 60 seconds first. If the computer comes back, or another full copy of the model
  is still running, nothing reloads. If Parallax moves layers while running, the pool restarts cleanly.

### 4. Heartbeat grace (slow joiners)
- **Before:** a computer that joined more than 30 seconds late was thrown out.
  Everybody had to join within 30 seconds.
- **After:** a late computer gets a fresh timer when it gets its layers. It is not thrown out.

### 5. Ghost guard and admission
- **Before:** old leftover processes came back as "ghost" computers. Anybody who knew the network
  name could try to join.
- **After:** unknown computers cannot sneak back in. A join without hardware details is refused.
  Optionally, only computers that are registered and sending signed heartbeats can join.

### 6. Clean restart after layers move
- **Before:** after Parallax moved layers, requests sometimes hung until a person restarted everything.
- **After:** the gateway sees the move and tells every computer in the pool to restart cleanly.
  No requests go to the pool until all computers confirm.

### 7. Network address change
- **Before:** if a computer's IP address changed, it silently stopped working.
- **After:** the node agent sees the new address, updates the settings file and restarts.
  (Firewall rules still need a person.)

### 8. Automatic pool formation
- **Before:** a person had to decide which computers form a pool.
- **After:** a computer can register in pool "auto". The computers measure the delay to each other.
  The gateway groups computers that are close (under 5 ms) and have enough memory for a model.
  One script on the gateway computer starts the pool's scheduler.

### 9. Many pools and coordinator election
- **Before:** only one pool, with one fixed coordinator.
- **After:** many pools, each with its own private scheduler on the gateway computer. The gateway
  picks the most reliable computer to publish the pool listing, and picks a new one if it stops.

### 10. Exact route for each request
- **Before:** we guessed which computers did the work from their heartbeats.
- **After:** we read the real route from the Parallax scheduler and use it on the receipt.

### 11. Coordinator cross-check
- **Before:** we had to trust the coordinator's report.
- **After:** each computer counts the requests it really served. The gateway compares the counts
  and shows a warning flag if they do not match. (No money is taken away yet: that needs 16.3.)

### 12. WAN / pools over the internet (partly done)
- **Before:** LAN only.
- **After:** the scripts can use our own relay servers and a scheduler address over the internet.
- **Still missing:** we have not run a relay server or tested a pool over the internet.

### 13. Memory-aware scheduling
- **Before:** a 16 GB Mac could run out of memory and slow down a lot (swap).
- **After:** a Mac cannot start without the safe memory settings. The agent watches swap.
  If a computer starts swapping, the gateway stops sending requests to that pool.

### 14. Speculative decoding and batching (batching done)
- **Before:** one request at a time per pool.
- **After:** the number of requests at the same time per pool is a setting (default still 1).
  The batch size of each computer is a setting too.
- **Speculative decoding: not done.** Parallax has no switch for it. Adding it means changing
  Parallax, which our rules do not allow.

### 15. Privacy
- **Before:** any computer could hold the first layers (closest to the user's words). Prompts were
  saved as plain text. The public ledger had plain hashes, so somebody could guess short prompts.
  No HTTPS.
- **After (no Parallax change):**
  - `x-gpupool-privacy: trusted-all` → every layer runs only on your own (or trusted) computers.
    Nobody else sees anything. `trusted-ends` → only the first and last layers.
  - Privacy requests save no transcript at all. Other transcripts are encrypted on disk.
  - The public hashes are salted: guessing does not work, but you can still check your own receipt.
  - The gateway can run HTTPS. The pool scripts stop Parallax from writing prompts into its logs.
- **Show it:** `pnpm --filter @gpupool/gateway demo:privacy` prints all of this with real data.

---

## 16.2, 16.3, 16.4: not started

These parts were not built in this round. The plan for each one is in `docs/POST_MVP_PLAN.md`
(P6 verification, P7 incentives, P8 Hedera and Arkiv, plus the legal check).

| Section | Items still out of scope |
|---|---|
| 16.2 Verification | output checks (Token-DiFR), verifier choice and appeals, hardware challenge, group testing |
| 16.3 Incentives | vesting, penalties and bans, stage blame, earned-credit expiry, collusion checks, node cap, Passport tier, Agent Pass, routing preferences, availability rewards |
| 16.4 Hedera and Arkiv | contract v2, legal check, USDC, scheduled transactions, ERC-8004, Swarm bundles, multiple gateways, Postgres |

---

## What a person must do before the demo

1. Delete the old gateway database (the format changed: now version 9).
2. Run the pool once with the hooks on and check the logs for `gpupool hooks: patched`.
3. To use the new features, fill the new settings (all are empty or off by default):
   `AUTO_RESTART`, `NOTIFY_PORT`, `PARALLAX_ROUTE_LOG`, `PARALLAX_ALLOWED_PEERS_FILE`,
   `POOL_COORDINATORS_FILE`, `TRUSTED_ACCOUNTS` (see `docs/HANDOFF.md` section 8).
4. Keep starting all computers within 30 seconds until the grace hook is checked on the real pool.
5. Test one real failover: unplug a Mac while it answers, and see the answer continue.

Where the details are: `docs/SPEC.md` sections 3.4, 3.5, 4.3, 5.3 (step 12), 5.4, 5.5;
`pool/README.md`; `node-agent/README.md`; `gateway/README.md`.
