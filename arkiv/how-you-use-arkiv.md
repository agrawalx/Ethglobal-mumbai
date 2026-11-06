# How we use Arkiv

Arkiv is the **public directory** of the GPU pool network (SPEC §11): what exists **now**. Each record has an owner and an expiry.

1. **Node listings (`gpupool.node`)**: each node agent writes its own listing with its own node key (owner-signed) and re-sets the
   expiry every 30 s (TTL 120 s). A node that stops cannot extend; its listing disappears by itself. No cleanup code.
2. **Pool listings (`gpupool.pool`)**: the pool coordinator writes the pool: models, members, status, layer map. TTL 120 s, every 30 s.
3. **Router read path**: the gateway router reads `gpupool.pool` entities with `status = ready` that list the requested model, and
   picks a pool by `reliability × (1 − load)` (SPEC §5.4). The frontend model list comes from the same read.
4. **Model catalog (`gpupool.model`)**: the admin seeds one entity per model from `shared/config/gpupool.config.json` (`seed-models`), TTL 30 days.
5. **Account stats (`gpupool.account_stats`)**: the gateway publishes pseudonymous stats (account ID, earned, spent, ratio, reliability)
   at gateway startup and every 10 minutes (TTL 1 day) for the leaderboard. `gateway/src/account-stats.ts`
   uses the gateway writer key and owner-scoped upsert. The World nullifier never goes to Arkiv.

Write rates follow SPEC §11.4: blocks are ~2 s, so we never write per request.

Tooling: `arkiv/src` (`@gpupool/arkiv`): encode/decode, `upsert`, `startExtender`, readers, and a CLI that the Python node agent calls:

```bash
node arkiv/src/cli.ts upsert-node '{"type":"gpupool.node",...}'
node arkiv/src/cli.ts list-ready-pools Qwen/Qwen3-14B-FP8
```

Schema details: `schema.md`. Writer wallet addresses: TODO (filled after the first live writes; `cli.ts address` prints them).
