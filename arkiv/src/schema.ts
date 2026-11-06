import { bytes, defineSchema, str } from "@arkiv-network/sdk/schema";
import { and, eq, or } from "@arkiv-network/sdk/query";
import { hexToString, stringToBytes } from "viem";
import type { z } from "zod";
import {
  ARKIV_ENTITY,
  ARKIV_INDEXED,
  ArkivAccountStats,
  ArkivModel,
  ArkivNode,
  ArkivPool,
} from "@gpupool/shared";

/**
 * Arkiv encoding of the shared entities (see arkiv/schema.md).
 * SDK 1.0.1 has typed columns, no payload field. So:
 * - every field in ARKIV_INDEXED → an indexed `str` column (exact-match queries);
 * - every other field → one JSON object in the `payload` bytes column (numbers stay exact JSON numbers);
 * - ArkivPool.models (array) → indexed slots model0..model3 (Arkiv has no array values or contains).
 * Each schema is named after the entity type, so the SDK also tags it with `arkiv.schema`.
 */

/** MVP pools serve one model; 4 slots leave room. A pool with more models fails to encode. */
export const POOL_MODEL_SLOTS = ["model0", "model1", "model2", "model3"] as const;

const ix = () => str().indexed();
const payload = () => bytes();

export const NodeSchema = defineSchema(ARKIV_ENTITY.node, {
  type: ix(), owner_account: ix(), node_id: ix(), pool_id: ix(), gpu: ix(), status: ix(), payload: payload(),
});
export const PoolSchema = defineSchema(ARKIV_ENTITY.pool, {
  type: ix(), pool_id: ix(), status: ix(),
  model0: ix(), model1: ix().optional(), model2: ix().optional(), model3: ix().optional(),
  payload: payload(),
});
export const ModelSchema = defineSchema(ARKIV_ENTITY.model, { type: ix(), model_id: ix(), payload: payload() });
export const AccountStatsSchema = defineSchema(ARKIV_ENTITY.accountStats, { type: ix(), account_id: ix(), payload: payload() });

export type Kind = "node" | "pool" | "model" | "accountStats";

type EntityOf = { node: ArkivNode; pool: ArkivPool; model: ArkivModel; accountStats: ArkivAccountStats };

export const KINDS = {
  node: { schema: NodeSchema, shared: ArkivNode, idField: "node_id" },
  pool: { schema: PoolSchema, shared: ArkivPool, idField: "pool_id" },
  model: { schema: ModelSchema, shared: ArkivModel, idField: "model_id" },
  accountStats: { schema: AccountStatsSchema, shared: ArkivAccountStats, idField: "account_id" },
} as const satisfies Record<Kind, { schema: unknown; shared: z.ZodType; idField: string }>;

/** Column values as the SDK takes them: indexed strings + payload bytes. */
export type Encoded = Record<string, string | Uint8Array>;

const jsonBytes = (o: object) => stringToBytes(JSON.stringify(o));

/** Validate with the shared schema, then split into indexed columns and the JSON payload. */
export function encode<K extends Kind>(kind: K, entity: EntityOf[K]): Encoded {
  const parsed = KINDS[kind].shared.parse(entity) as Record<string, unknown>;
  const indexed = new Set<string>(ARKIV_INDEXED[parsed.type as keyof typeof ARKIV_INDEXED]);
  const out: Encoded = {};
  const rest: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(parsed)) {
    if (!indexed.has(k)) rest[k] = v;
    else if (k === "models") {
      const models = v as string[];
      if (models.length > POOL_MODEL_SLOTS.length) throw new Error(`a pool lists at most ${POOL_MODEL_SLOTS.length} models`);
      models.forEach((m, i) => (out[POOL_MODEL_SLOTS[i]!] = m));
    } else out[k] = String(v);
  }
  out.payload = jsonBytes(rest);
  return out;
}

/** A row as the SDK returns it: each column is `{type, value}`; bytes values are hex. */
export type Row = Record<string, unknown>;

const cell = (row: Row, k: string): unknown => {
  const c = row[k];
  return c && typeof c === "object" && "value" in c ? (c as { value: unknown }).value : c;
};

export type Decoded<K extends Kind> = { ok: true; entity: EntityOf[K] } | { ok: false; error: string };

/** Rebuild the shared entity from a row and validate it. Invalid rows are reported, not thrown. */
export function decode<K extends Kind>(kind: K, row: Row): Decoded<K> {
  const { shared } = KINDS[kind];
  const type = cell(row, "type");
  const indexed = ARKIV_INDEXED[type as keyof typeof ARKIV_INDEXED];
  if (!indexed) return { ok: false, error: `unknown type ${String(type)}` };
  let rest: Record<string, unknown>;
  try {
    const p = cell(row, "payload");
    const text = typeof p === "string" ? hexToString(p as `0x${string}`) : new TextDecoder().decode(p as Uint8Array);
    rest = JSON.parse(text) as Record<string, unknown>;
  } catch (e) {
    return { ok: false, error: `bad payload: ${(e as Error).message}` };
  }
  const obj: Record<string, unknown> = { ...rest };
  for (const k of indexed) {
    if (k === "models") obj.models = POOL_MODEL_SLOTS.map((s) => cell(row, s)).filter((m) => typeof m === "string" && m);
    else obj[k] = cell(row, k);
  }
  const r = shared.safeParse(obj);
  return r.success ? { ok: true, entity: r.data as EntityOf[K] } : { ok: false, error: r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") };
}

// ---------- query expressions (the router's read path) ----------

/** Ready pools that list `model` in any slot. */
export const readyPoolsWhere = (model: string) =>
  and(eq("status", "ready"), or(POOL_MODEL_SLOTS.map((s) => eq(s, model))));

export const nodesWhere = (poolId?: string) => (poolId ? eq("pool_id", poolId) : eq("type", ARKIV_ENTITY.node));

export const idWhere = (kind: Kind, id: string) => eq(KINDS[kind].idField, id);
