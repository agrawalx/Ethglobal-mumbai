# Arkiv schema (gpupool)

Network: Arkiv testnet **Rabdi**, chain ID 7794095, RPC `https://rpc.rabdi.db-chain.testnet.arkiv.network/<access-key>`.
SDK: `@arkiv-network/sdk` **1.0.1** + `viem` 2. Code: `arkiv/src/schema.ts`. Logical records: `shared/src/arkiv.ts`.

SDK 1.0 has typed columns (`defineSchema`) and no free payload field. Our encoding:

- Each entity type is a **named schema** (`gpupool.node`, …). The SDK adds the indexed attribute `arkiv.schema = <name>`; we also keep an indexed `type` column (shared rule: `type` is always indexed).
- Every field in `ARKIV_INDEXED` → an **indexed `str` column** (exact-match queries).
- Every other field → one JSON object in the `payload` **bytes** column. Numbers (`mem_gb`, `tok_s`, `reliability`, `ratio`, `*_mc`, `model_factor`, `size_gb`) stay exact JSON numbers, so **no numeric scaling** is needed. No query filters on them in the MVP. If one is needed later, add a `dec()` column (signed fixed-point, 18 decimals).
- `gpupool.pool.models` (array) → indexed slots **`model0`..`model3`** (Arkiv has no array values and no "contains" operator). MVP pools serve one model; a pool with more than 4 models fails to encode. Query: `model0 = m OR model1 = m OR …`.
- Every write validates with the shared zod schema first; every read validates again and **skips + logs** invalid entities.

| Entity | Indexed str columns | payload (JSON) | Writer | Expiry (`shared/config` `arkiv_ttl_s`) |
|---|---|---|---|---|
| `gpupool.node` | type, owner_account, node_id, pool_id, gpu, status | mem_gb, layers, tok_s, reliability | node agent (node key) | 120 s, re-set every 30 s |
| `gpupool.pool` | type, pool_id, status, model0..model3 | members, coordinator_url_hash, layer_map (null while no valid map; from gateway `GET /pools/:pool_id`) | coordinator (pool key) | 120 s, re-set every 30 s |
| `gpupool.model` | type, model_id | mlx_variant, size_gb, model_factor, license | admin (gateway key) | 30 days |
| `gpupool.account_stats` | type, account_id | earned_mc, spent_mc, ratio, reliability | gateway | 1 day, updated every 10 min |

## Queries

```text
-- router (SPEC §5.4): ready pools for a model
status = str('ready') AND (model0 = str('Qwen/Qwen3-14B-FP8') OR model1 = str('Qwen/Qwen3-14B-FP8') OR model2 = str('Qwen/Qwen3-14B-FP8') OR model3 = str('Qwen/Qwen3-14B-FP8'))
-- nodes of a pool
pool_id = str('pool-mumbai-1')
```

Runnable: `pnpm --filter @gpupool/arkiv cli list-ready-pools Qwen/Qwen3-14B-FP8` (also `list-models`, `list-nodes [pool]`, `list-stats`).

## Writes

`upsert` (`src/writer.ts`): find the writer's own entity by its id column (`ownedBy(writer)`); if none, `createEntity`; else one
`executeBatch({patches, extensions})` transaction: patch the columns and **set** the expiry to now + TTL. Rates: SPEC §11.4 (never per request).
