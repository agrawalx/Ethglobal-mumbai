import { ExpirationTime, type PublicArkivClient, type WalletArkivClient } from "@arkiv-network/sdk";
import type { Hex } from "viem";
import type { GpupoolConfig } from "@gpupool/shared";
import { encode, idWhere, KINDS, POOL_MODEL_SLOTS, type Kind } from "./schema.ts";

/** TTL (seconds) per kind, from shared config arkiv_ttl_s (SPEC §11.2). */
export const ttlFor = (cfg: GpupoolConfig, kind: Kind): number =>
  ({ node: cfg.arkiv_ttl_s.node, pool: cfg.arkiv_ttl_s.pool, model: cfg.arkiv_ttl_s.model, accountStats: cfg.arkiv_ttl_s.account_stats })[kind];

export type UpsertResult = { entityKey: Hex; txHash: Hex; created: boolean };

/**
 * Create the entity once; afterwards patch its columns and extend its expiry in ONE transaction.
 * The existing entity is found by its id field among the writer's own entities, so a restarted
 * writer (or the one-shot CLI) finds its listing again. Expiry is SET to now + ttl (extend does
 * not add). Call it at most every ARKIV_EXTEND_SECONDS (SPEC §11.4: never per request).
 */
export async function upsert<K extends Kind>(
  pub: PublicArkivClient,
  wallet: WalletArkivClient,
  kind: K,
  entity: Parameters<typeof encode<K>>[1],
  ttlSeconds: number,
): Promise<UpsertResult> {
  const { schema, idField } = KINDS[kind];
  const values = encode(kind, entity);
  const expiration = ExpirationTime.fromSeconds(ttlSeconds);
  if (!wallet.account) throw new Error("Arkiv wallet client has no account");
  const owner = wallet.account.address;
  const found = await pub
    .select({ $key: true })
    .from(schema)
    .where(idWhere(kind, String(values[idField])) as never)
    .ownedBy(owner)
    .limit(1)
    .fetch();
  const existing = found.entities[0]?.$key as Hex | undefined;

  if (!existing) {
    const r = await wallet.createEntity(schema as never, values as never, { expiration });
    return { entityKey: r.entityKey, txHash: r.txHash, created: true };
  }
  // Optional pool model slots that are no longer used must be unset, not left stale.
  const unset = kind === "pool" ? POOL_MODEL_SLOTS.slice(1).filter((s) => !(s in values)) : [];
  const patch = unset.length > 0 ? { set: values, unset } : { set: values };
  const r = await wallet.executeBatch({
    patches: [{ schema, entityKey: existing, ...patch } as never],
    extensions: [{ entityKey: existing, expiration }],
  });
  return { entityKey: existing, txHash: r.txHash, created: false };
}

/**
 * Run `task` now and then every `intervalSeconds` (default ARKIV_EXTEND_SECONDS = 30).
 * A failed run is logged and retried at the next tick; runs never overlap. Returns stop().
 */
export function startExtender(task: () => Promise<unknown>, intervalSeconds: number, label = "arkiv"): () => void {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await task();
    } catch (e) {
      console.error(`${label}: write failed, retry in ${intervalSeconds}s: ${(e as Error).message}`);
    } finally {
      running = false;
    }
  };
  void tick();
  const t = setInterval(tick, intervalSeconds * 1000);
  return () => clearInterval(t);
}

export const extendSeconds = (env: Record<string, string | undefined> = process.env): number => {
  const n = Number(env.ARKIV_EXTEND_SECONDS ?? 30);
  if (!Number.isInteger(n) || n <= 0) throw new Error(`ARKIV_EXTEND_SECONDS must be a positive integer, got ${env.ARKIV_EXTEND_SECONDS}`);
  return n;
};
