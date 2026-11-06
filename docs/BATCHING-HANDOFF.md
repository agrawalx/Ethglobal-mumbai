# Handoff: request batching (throughput) for GPU Pool

For the next agent. Read `CLAUDE.md`, `docs/HLD.md`, `docs/SPEC.md` (§5, §8, §16.1) and
`docs/PROVIDER-ONBOARDING.md` first. This file is the complete brief for the batching task.

## 1. Goal

Serve several requests on one pool at the same time so the pipeline's stages work in parallel.
Today one request runs per pool, so in a 3-stage pipeline (M4 → M5 → RTX 4060) each laptop is idle
about 2/3 of the time. Expected result: total throughput ≈ 2–3× (≈ 8 → 18–24 tok/s across users),
per-request speed ≈ 10–25 % lower. Single-request speed is NOT the goal: it is near the hardware
ceiling (≈ 95 ms/token of weight reads → ≈ 10.5 tok/s max; measured ≈ 8 tok/s).

## 2. Current state (what serializes requests)

| Layer | Setting | Where | Now |
|---|---|---|---|
| Gateway queue | `router.max_concurrent_per_pool` | `shared/config/gpupool.config.json` → `gateway/src/queue.ts` (`createPoolQueue(slots)`), used in `gateway/src/main.ts` and `app.ts` | **1** |
| Node batching (managed pools, website onboarding) | `MAX_BATCH_SIZE` in the generated `pool/node.env` | `pool/bootstrap/host.py` → `configure()` (`"MAX_BATCH_SIZE": 1`), used by `pool/provider/helper.py` | **1** |
| Node batching (manual pools) | `MAX_BATCH_SIZE` env → `--max-batch-size` | `pool/join-node.sh` line ~52 | unset → Parallax default 8 |
| Parallax node args | `--max-batch-size` (default 8), `--micro-batch-ratio` (default 1; micro batch = max_batch_size // ratio), `--scheduler-wait-ms` (default **500**: time to gather a batch, adds first-token delay), `--max-num-tokens-per-batch` (16384), `--chunked-prefill-size` (1024), `--max-sequence-length`, `--kv-cache-memory-fraction` (Macs use 0.25) | `~/parallax/src/parallax/server/server_args.py` (Parallax pinned at `162354a`, never patch it) | — |

The queue already supports N slots and ratio priority (highest contribution ratio first,
arrival order on ties). Billing, routes, receipts and HCS events are per request and need no change.

## 3. Work plan

1. **Make the node batch flags configurable** (not hard-coded 1):
   - `pool/bootstrap/host.py` `configure()`: `MAX_BATCH_SIZE` from the pool (default 4), and add
     `--micro-batch-ratio` and `--scheduler-wait-ms` through `EXTRA_FLAGS` (or new env keys passed
     by `pool/join-node.sh`, like `MAX_BATCH_SIZE`). Keep the Mac flags
     (`--kv-cache-memory-fraction 0.25 --max-sequence-length 4096`).
   - Starting values to benchmark: `--max-batch-size 4`, `--micro-batch-ratio 2` (micro batch 2, so
     stage 1 works on one micro-batch while stage 2 works on another), `--scheduler-wait-ms 50`.
   - The helper bundle is served by the gateway (`gateway/src/provider-assets.ts`, cached in memory):
     restart the gateway after changing `host.py`/`helper.py`, then click **Retry setup** on the
     coordinator's Getting Started page so every node restarts with the new flags.
2. **Coordinator helper must serve relay jobs concurrently (required).** `pool/provider/helper.py`
   `jobs()` (≈ line 434) calls `forward_job()` synchronously, so today the coordinator forwards ONE
   job at a time and gateway concurrency never reaches Parallax. Run each job in its own thread (or
   a small pool sized to `MAX_BATCH_SIZE`), keep polling while jobs run, and keep the user-agent
   header (`USER_AGENT`, Cloudflare blocks `Python-urllib` with 403 error 1010). Add a test in
   `pool/provider/tests`.
3. **Gateway concurrency:** `router.max_concurrent_per_pool` 1 → 4 (benchmark 2 and 4). Make the
   router's load term reflect slots: today `load = active / (active + 1)` in `gateway/src/router.ts`;
   use `active / slots` so a pool at 1 of 4 slots is not scored as 50 % loaded.
4. **Stall detection under concurrency:** `gateway/src/stall.ts` keeps one gap history per pool. With
   batching, token gaps per stream grow; check that `stall_p95_factor × p95` still avoids false
   stalls (5 s minimum today). Consider a per-pool warm-up (no stall verdicts for the first N samples).
5. **Benchmark** (write `scripts/bench-concurrency.mjs` or extend `scripts/bench-pool.py`): send 1, 2,
   4 and 8 concurrent streaming requests (256 output tokens each) through the gateway with a dev
   session (`node --env-file=gateway/.env gateway/scripts/dev-session.ts <label>`), and record per
   request: time to first token, decode tok/s; and in total: aggregate tok/s and wall time. Run it
   once with the old flags and once with the new ones. Record results in `docs/LIVE-DEMO-RUNBOOK.md`.
6. **Memory check on the Macs** while the benchmark runs (`ssh … 'sysctl -n vm.swapusage; memory_pressure'`).
   KV cache estimate for Qwen3-14B: ≈ 4 KB per layer per token (K+V, 8 KV heads × 128 dims × 2 B ×
   2) → a Mac stage of 14–15 layers ≈ 60 KB/token → 4 requests × 4096 tokens ≈ 1 GB per Mac. The
   16 GB Macs already swap at times; if swap grows under batching, drop to 2 concurrent.
7. **Tests:** queue with N slots (exists in `gateway/test/queue.test.ts` / `priority.test.ts`; add
   a case for slots = 4), router load term, `host.py` env generation (`pool/bootstrap/tests`).
8. **Docs:** SPEC §16.1 (batching row), HANDOFF §8 (any new env keys), this file's results section.

## 4. Interactions to keep in mind

- **Client cancel drains, never aborts** (commit `a5b1ac5`, `gateway/src/chat.ts`): Parallax 162354a
  crashes its last stage ("Decode request … must already be admitted") when a running request is
  aborted. A cancelled request keeps its pool slot until the drain ends (capped at `POOL_TIMEOUT_MS`).
  With batching, verify a cancel in the middle of a batch does not crash any stage.
- **Swap pressure degrades, not excludes** (commit `c138070`): a pool with a member whose swap keeps
  growing gets score × 0.5 (`SWAP_SCORE_FACTOR` in `gateway/src/router.ts`). Batching raises memory
  use, so watch for `pool_degraded` in the gateway log.
- **Pool reliability** is per pool (0.7 success + 0.3 uptime, `gateway/src/reliability.ts`); failed
  batched requests count against the pool.
- **Provider relay** (`gateway/src/provider-relay.ts`): caps 8 queued jobs per pool and 16 MB per
  response, and the gateway side already supports concurrent jobs.

## 5. Live environment (as of 7 Nov 2026)

| Item | Value |
|---|---|
| Gateway | this Linux laptop, `cd gateway && node --env-file-if-exists=.env src/main.ts` (log `gateway/data/live/gateway.log`), port 8080, SQLite `gateway/data/gateway.sqlite` (schema v17+) |
| Public URL | `https://ethglobal.yash-agrawal.dev` (Cloudflare tunnel `ethglobal`, config `~/.cloudflared/ethglobal.yml`, log `gateway/data/live/tunnel.log`); the tunnel stalls ≈ 10 s at times |
| Frontend | `https://gpupool-ethglobal.vercel.app` (static build deployed from `pool/run/gpupool-ethglobal`, see the deploy commands in `docs/PROVIDER-ONBOARDING.md` / git log) |
| Pool | `pool_2de761a5d17057548086b5f5`: coordinator = this Linux laptop (4060, layers [29,40)), M5 `10.73.166.81` [14,29), M4 `10.73.210.140` [0,14); helpers run in Terminal on each laptop; restart with **Retry setup** |
| Coordinator helper | must use the local gateway URL (`--gateway http://127.0.0.1:8080`), not the tunnel |
| SSH to Macs | `ssh -i ~/.ssh/gpupool_m5 -o IdentitiesOnly=yes sarnav07@10.73.166.81` / `mohitgrover@10.73.210.140` |
| Restart the gateway safely | find its process group: `ps -o pgid= -p $(pgrep -f "^node --env-file-if-exists=.env src/main.ts")`, `kill -TERM -- -<pgid>`; never `pkill -f` a pattern that also matches your own shell (it killed the shell before) |

## 6. Done when

- Benchmark table for 1/2/4(/8) concurrent requests, before and after, in the runbook.
- Aggregate tok/s clearly above the 1-concurrent baseline, with no stage crash, no `pool_skipped`,
  and Mac swap stable during the run.
- Gateway, shared, frontend, node-agent and bootstrap tests pass; changes committed with short
  one-line messages (no co-author lines) and pushed.
