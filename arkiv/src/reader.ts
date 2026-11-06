import type { PublicArkivClient } from "@arkiv-network/sdk";
import type { Address } from "viem";
import type { ArkivAccountStats, ArkivModel, ArkivNode, ArkivPool } from "@gpupool/shared";
import { decode, KINDS, nodesWhere, readyPoolsWhere, type Kind, type Row } from "./schema.ts";

/** Optional filter: only entities owned by this writer (e.g. the admin wallet for the model catalog). */
export type ReadOptions = { owner?: Address };

/**
 * Decode rows with the shared schema. Invalid entities are skipped and logged, never returned.
 * MVP: one page (100 rows, the node maximum) is enough for the demo network.
 */
function decodeAll<K extends Kind>(kind: K, rows: Row[], skippedBySdk: number) {
  if (skippedBySdk > 0) console.warn(`arkiv: ${skippedBySdk} ${KINDS[kind].schema.name} rows did not match the schema (skipped)`);
  const out = [];
  for (const row of rows) {
    const d = decode(kind, row);
    if (d.ok) out.push(d.entity);
    else console.warn(`arkiv: skip invalid ${kind} ${String(row.$key ?? "")}: ${d.error}`);
  }
  return out;
}

async function list<K extends Kind>(pub: PublicArkivClient, kind: K, where: Parameters<ReturnType<PublicArkivClient["select"]>["where"]>[0] | undefined, opts: ReadOptions) {
  let q = pub.select().from(KINDS[kind].schema as never) as ReturnType<PublicArkivClient["select"]>;
  if (where) q = q.where(where);
  if (opts.owner) q = q.ownedBy(opts.owner);
  const res = await q.limit(100).fetch();
  return decodeAll(kind, res.entities as Row[], res.skipped);
}

/** Public network view includes ready, loading and offline pools until their Arkiv expiry. */
export const listPools = (pub: PublicArkivClient, opts: ReadOptions = {}) =>
  list(pub, "pool", undefined, opts) as Promise<ArkivPool[]>;

/** Router read path (SPEC §5.4 step 1): pools with status=ready that list the model. */
export const listReadyPools = (pub: PublicArkivClient, model: string, opts: ReadOptions = {}) =>
  list(pub, "pool", readyPoolsWhere(model), opts) as Promise<ArkivPool[]>;

export const listModels = (pub: PublicArkivClient, opts: ReadOptions = {}) =>
  list(pub, "model", undefined, opts) as Promise<ArkivModel[]>;

export const listNodes = (pub: PublicArkivClient, poolId?: string, opts: ReadOptions = {}) =>
  list(pub, "node", nodesWhere(poolId), opts) as Promise<ArkivNode[]>;

export const listAccountStats = (pub: PublicArkivClient, opts: ReadOptions = {}) =>
  list(pub, "accountStats", undefined, opts) as Promise<ArkivAccountStats[]>;
