# Friction log (Arkiv)

SDK checked: `@arkiv-network/sdk` **1.0.1** (npm, published 2026-11-02; the package ships `src/`, which we read). Docs: https://docs.arkiv.network/
(`/start-here/first-entity/`, `/reference/query-language/`, `/reference/limits/`).

## Confirmed API (1.0.1)

| Need | API |
|---|---|
| Chain | `rabdi({ accessKey })` from `@arkiv-network/sdk/chains`. It is a function; it puts the access key in the RPC URL path. `accessKey: ""` = public, rate-limited endpoint (warns). |
| Clients | `createPublicClient({ chain, transport: http() })`, `createWalletClient({ chain, transport, account: privateKeyToAccount(pk) })` (`viem/accounts`) |
| Schema | `defineSchema(name, { col: str().indexed(), payload: bytes(), x: str().optional() })` from `/schema`. Types: bool, i32, u64, u256, dec, str, addr, key, bytes |
| Create | `wallet.createEntity(schema, values, { expiration: ExpirationTime.fromSeconds(n) })` → `{ entityKey, txHash, expiresAt }` |
| Update | `wallet.patchEntity(schema, key, { set, unset })` (partial; never changes expiry) |
| Extend | `wallet.extendEntity({ entityKey, expiration })`: **sets** expiry to now + n (does not add) |
| Delete | `wallet.deleteEntity({ entityKey })` |
| Batch | `wallet.executeBatch({ creates, patches, deletes, extensions })` (one atomic tx) |
| Query | `pub.select(...).from(schema).where(and(eq(..), or(..))).ownedBy(addr).limit(100).fetch()` → `{ entities, skipped }`; operators from `/query`: eq gt gte lt lte between startsWith exists hasType and or |
| Funds | Writes pay gas in tGLM: https://hub.arkiv.network/faucet. Access keys: https://hub.arkiv.network/access-keys |

## Friction

1. **Old API everywhere.** Tutorials, older docs and LLM memory show the pre-1.0 API (payload + contentType, string/numeric annotations,
   `expiresIn`/BTL, `buildQuery()`, `updateEntity`). 1.0.1 replaced all of it. The README still shows `"^0.9.0"` in a package.json
   snippet. The old docs path `/writing/expiration/` redirects to the docs root.
2. **No payload field.** Blobs go in a `bytes()` column; we store the non-indexed fields as JSON there and decode by hand (`hexToString`).
3. **No arrays and no "contains".** A pool's model list needs fixed slots (`model0..model3`) or one entity per (pool, model).
4. **Docs list `ne` / `not`, but 1.0.1 exports neither** (`NOT` is reserved in the language and not usable).
5. **Bare JS numbers become `i32`.** A query with `dec(5)` does not match a value written as `5`. We avoid numeric columns.
6. **`ExpirationTime.fromSeconds` needs a positive multiple of 2** (block time 2 s). Our TTLs (120, 86400, 2592000) are even.
7. **TypeScript generics:** the typed `where()` rejects an expression built for a union of schemas; we cast at one call site.
8. **No exported offline validator** for column values (`encodeCreate` is internal), so value/schema mismatches show only on a live write.
