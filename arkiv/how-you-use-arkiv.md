## Do the things you filter on, who can edit each entity, and when it expires fit what your app does?

Arkiv is our public discovery layer. We query what a requester needs to know: which pools advertise the requested model as ready, and which nodes belong to a pool.

| Entity | Filters we use | Wallet that owns and edits the entity | Expiration |
|---|---|---|---|
| `gpupool.node` | `pool_id` for pool membership; `node_id` for writer upserts | The node's own wallet | 120 seconds, renewed every 30 seconds |
| `gpupool.pool` | `status = ready` AND requested model in `model0`–`model3`; `pool_id` for upserts | The elected pool writer, using its pool key or its node key | 120 seconds, renewed every 30 seconds |
| `gpupool.model` | Named-schema catalog read; `model_id` for upserts | The admin's catalog writer wallet | 30 days; refreshed by rerunning the seed command |
| `gpupool.account_stats` | Named-schema stats read; `account_id` for upserts | The gateway's stats writer wallet | 1 day, refreshed at startup and every 10 minutes |

Short node/pool lifetimes match machines that can disconnect at any moment. Model metadata changes less often, so it lasts longer. Contribution statistics are periodic public snapshots, so they tolerate slower updates but expire if publishing stops. Each upsert looks up the logical ID within the writer's own entities, then patches and renews the existing record in one transaction.

## Does each Arkiv feature you use change something your users see?

- **Indexed queries:** Selecting a model finds matching ready pools. The model picker only includes configured catalog models with an eligible pool; loading or offline pools remain visible on the network page until expiry.
- **Time-scoped records:** When renewal stops, expired nodes and pools disappear from subsequent directory reads. Expired model entries leave the catalog, and expired statistics leave the Contributors table.
- **Wallet ownership and signed writes:** Providers control updates to their own node records; another provider cannot overwrite that entity. A signature identifies the publisher, rather than proving its hardware claims. The gateway additionally checks registration, fresh signed heartbeats, and layer coverage before routing.
- **Queryable public data:** The network page displays pool membership, GPU memory, status, and reliability; the Contributors table displays pseudonymous earned/spent totals and ratios. Other clients can query the same records directly.
- **Atomic patch and renewal:** Updated status/model fields and a renewed lifetime commit together. Removing a model also clears its old indexed slot, so it no longer matches discovery queries.

Implementation: [schemas and filters](src/schema.ts), [owner-scoped writes](src/writer.ts), [routing and network reads](../gateway/src/router.ts), and [statistics publishing](../gateway/src/account-stats.ts).
