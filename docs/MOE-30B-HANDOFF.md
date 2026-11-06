# Handoff: run Qwen3-30B-A3B (MoE) on a Mac + RTX pool

For the next agent. Read `CLAUDE.md`, `docs/HLD.md`, `docs/SPEC.md`, `docs/PROVIDER-ONBOARDING.md`,
`docs/BATCHING-HANDOFF.md` (live environment, §5) and `docs/MAC-SSH-TESTING.md` first.

## 1. Goal

A faster, bigger demo model: **Qwen3-30B-A3B-Instruct-2507** (mixture of experts, ≈ 30.5B total, ≈ 3.3B
active per token, 48 layers). It needs the memory of a 30B model but decodes like a ~3B one:
expected **≈ 15–25 tok/s per answer** (vs ≈ 8 tok/s for Qwen3-14B today). Use the **Instruct** variant
(no thinking tokens). Run it on **4–5 × 16 GB Apple-silicon Macs + the RTX 4060 laptop** (this
Linux machine, the coordinator), through the website's provider onboarding.

## 2. Model files (Parallax catalog, pinned commit 162354a)

| Backend | Repo | Size |
|---|---|---|
| CUDA (RTX 4060) | `Qwen/Qwen3-30B-A3B-Instruct-2507-FP8` | ≈ 31 GB |
| Apple MLX | `lmstudio-community/Qwen3-30B-A3B-Instruct-2507-MLX-8bit` (Parallax maps the FP8 id to it in `~/parallax/src/backend/server/static_config.py`) | ≈ 32.5 GB |

Memory budget: a 16 GB Mac holds ≈ 8–8.5 GB of weights without swapping (they swap with more); the
4060 holds ≈ 5 GB (≈ 7–8 layers). 4 Macs + 4060 ≈ 39 GB for 32.5 GB (works, modest headroom);
5 Macs + 4060 ≈ 47 GB (comfortable, batching room). KV cache is small (48 layers × 4 KV heads ×
128 dims × 2 B × 2 ≈ 96 KB per token for the whole model).

The coordinator (this Linux laptop) needs BOTH formats (≈ 65 GB free disk); each Mac only the MLX one.
The user is pre-downloading them. Helpers reuse complete HF caches found in `$HF_HOME`,
`<parallax>/.cache/huggingface` or `~/.cache/huggingface` (`pool/provider/helper.py`
`seed_coordinator_cache`, `cache_candidates`, `download_from_pool` reuse by size + SHA-256).

## 3. Work plan

1. **Load test first (no code changes).** On this Linux laptop + 2 Macs, start a plain Parallax pool
   for `Qwen/Qwen3-30B-A3B-Instruct-2507-FP8` with the known-good commands in `docs/MAC-SSH-TESTING.md`
   §4 (hooks on: `GPUPOOL_HOOKS=1`, `PYTHONPATH=pool/hooks`), but only AFTER the user has stopped the
   live 14B pool (helpers run in owners' Terminals — ask them; never stop it yourself). Confirm:
   the FP8 MoE kernels compile and run on the 4060 (Ada, sm_89; the first start may JIT for minutes),
   MLX loads the 8-bit MoE on the Macs, placement in `scheduler.log` ("Post Bootstrap Layer
   Assignments"), a warm-up answer, and decode tok/s with `scripts/bench-pool.py`. If 2 Macs + 4060
   cannot hold it, test with 4 Macs. Record results in `docs/LIVE-DEMO-RUNBOOK.md`.
2. **Catalog.** Add the model to `shared/config/gpupool.config.json` (`model_id`
   `Qwen/Qwen3-30B-A3B-Instruct-2507-FP8`, `mlx_variant` above, `num_layers` 48, `size_gb` ≈ 32.5,
   `license` apache-2.0, a `model_factor` and `x402_prices` — propose values in your report: it is a
   bigger model but cheaper per token to run; keep 14B and 8B entries). Update shared examples/tests
   if the schema requires. Publish to Arkiv: `node --env-file=arkiv/.env arkiv/src/cli.ts seed-models`.
3. **Helper placement.** `pool/provider/helper.py` sets `--param-mem-ratio 0.37` only for the tested
   "Qwen3-14B × 3 members" profile. Find a value (or rule) that makes Parallax use every member for
   this model (it otherwise picks the fewest stages); keep Mac flags
   `--kv-cache-memory-fraction 0.25 --max-sequence-length 4096`.
4. **Bring-up guide** for the user: exact website steps (Create pool → choose the model, member count
   = Macs + 1, join, approve, install commands; coordinator uses `--gateway http://127.0.0.1:8080`),
   plus the firewall note (members ↔ each other on 5100–5200 TCP/UDP), and how to verify
   (`/v1/models`, Network page, chat). Put it in `docs/PROVIDER-ONBOARDING.md` or the runbook.
5. **Tests + docs:** shared/gateway/provider/bootstrap tests pass; SPEC model table, HANDOFF §8 if
   keys change.

## 4. Known pitfalls (from live runs)

- One node dropping stops the pool (pipeline). More nodes = more risk; use reliable Ethernet adapters
  (the 100 Mbps adapter issue is fixed).
- Close other apps on every Mac; swap now only halves the pool's router score (`SWAP_SCORE_FACTOR`),
  but it still slows every token.
- Never abort a running Parallax request (it crashes the last stage); the gateway drains on client
  cancel (commit `a5b1ac5`).
- Cloudflare blocks the `Python-urllib` user agent (403, error 1010); the helper sends its own.
- The simulator World ID gives one nullifier for every identity: member accounts for testing are made
  with `gateway/scripts/dev-session.ts` and a sessionStorage snippet (`gpupool.session.v1`).
- Batching settings (`node_batching` in shared config, `max_concurrent_per_pool` 2) apply to this pool
  too; the small KV cache allows a larger batch — benchmark with `scripts/bench-concurrency.mjs`.

## 5. Done when

The 30B-A3B pool serves chat through the website with the RTX 4060 + Macs, its decode tok/s and
concurrency numbers are in the runbook, the model is in the catalog and on Arkiv, and all tests pass.
Commit with short one-line messages (no co-author lines), `git pull --rebase`, `git push origin main`.
