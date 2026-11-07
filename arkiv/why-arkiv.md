## If you swapped Arkiv for Postgres or any other database, what would your users lose?

GPU Pool's directory is shared between independent compute providers and people looking for a model to run. Replacing Arkiv with our own Postgres instance could preserve the interface, but users would lose these guarantees unless we rebuilt them:

- **Tamper-evident & owner-controlled listings.** Each node publishes with its own wallet; the elected pool writer signs its pool listing. Arkiv records writes as signed transactions and commits state cryptographically. Users can inspect the publisher and current record independently of our gateway, rather than trust a database row our administrator can silently rewrite.
- **Time-scoped availability.** Node and pool listings have a 120-second lifetime, renewed every 30 seconds. If a laptop stops renewing, its listing drops out of Arkiv queries when that lifetime ends. A requester looking for a Qwen pool therefore stops discovering that stale listing without waiting for our cleanup job.
- **A publicly queryable directory.** Other clients can discover pools by model and status directly from Arkiv without access to our private database. Our own router uses that same query path to find candidate pools.

A signed listing proves who published a claim, not that the GPU exists or is serving correctly. Our gateway also checks fresh signed heartbeats and complete model-layer coverage before routing.

## What did you keep off Arkiv, and why?

We use **SQLite for the gateway's operational state**: accounts and World nullifiers, API-key hashes and budgets, spendable balances and credit holds, request records, transcripts, and detailed heartbeat data. The gateway reads and updates this data to authenticate users, admit requests, and settle usage. It needs private access and immediate atomic transactions; publishing each change to a shared directory adds **no** value to those operations.

Arkiv holds the data **others** need to discover and inspect: nodes, pools, the model catalog, and periodic pseudonymous contribution statistics. These statistics are public snapshots; authoritative spendable balances stay in SQLite. Private coordinator URLs stay off Arkiv; we publish their hashes. Signed accounting events go asynchronously to **Hedera HCS** for auditability, while model weights and inference traffic stay on the compute infrastructure.
