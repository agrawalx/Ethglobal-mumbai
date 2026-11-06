import type { GpupoolConfig, LayerRange, ModelConfig, PoolStateResponse, Route } from "@gpupool/shared";
import type { Db } from "./db.ts";

/**
 * Route source (SPEC §5.5). Parallax /cluster/status_json has no layer ranges, so each node agent
 * reports its own range in its signed heartbeat. The pool's layer map = the latest FRESH heartbeats
 * (≤ router.pool_heartbeat_max_age_s) of the pool's registered nodes. The map is valid only if the
 * ranges cover [0, num_layers) of the model exactly once (no gaps, no overlaps). Otherwise the route
 * is unknown (null) and the node shares of a request go to the reserve.
 */

export type NodeHb = { node_id: string; pool_id: string; hb_ts: number | null; hb_online: number | null; hb_model: string | null; hb_layers: string | null };

/** The config model a Parallax model name belongs to (GPU nodes report model_id, Macs the MLX variant). */
export function configModelFor(cfg: GpupoolConfig, name: string | null): ModelConfig | undefined {
  if (!name) return undefined;
  return cfg.models.find((m) => m.model_id === name || m.mlx_variant === name);
}

/** Order the hops by start layer and check exact cover of [0, total). null = invalid. */
export function validLayerMap(hops: { node_id: string; layers: LayerRange }[], total: number): Route | null {
  if (hops.length === 0) return null;
  const sorted = [...hops].sort((a, b) => a.layers[0] - b.layers[0]);
  let next = 0;
  for (const h of sorted) {
    if (h.layers[0] !== next || h.layers[1] <= h.layers[0]) return null;
    next = h.layers[1];
  }
  return next === total ? sorted.map((h) => ({ node_id: h.node_id, layers: [h.layers[0], h.layers[1]] as LayerRange })) : null;
}

const freshNodes = (db: Db, cfg: GpupoolConfig, poolId: string | null, now: number): NodeHb[] => {
  const minTs = now - cfg.router.pool_heartbeat_max_age_s * 1000;
  const sql = `SELECT node_id, pool_id, hb_ts, hb_online, hb_model, hb_layers FROM nodes WHERE hb_ts >= ? AND hb_online = 1${poolId ? " AND pool_id = ?" : ""}`;
  return (poolId ? db.prepare(sql).all(minTs, poolId) : db.prepare(sql).all(minTs)) as NodeHb[];
};

/** Layer map of one pool for one model, from fresh heartbeats. */
export function poolLayerMap(db: Db, cfg: GpupoolConfig, poolId: string, model: ModelConfig, now = Date.now()): Route | null {
  const hops = freshNodes(db, cfg, poolId, now)
    .filter((n) => n.hb_layers && configModelFor(cfg, n.hb_model)?.model_id === model.model_id)
    .map((n) => ({ node_id: n.node_id, layers: JSON.parse(n.hb_layers!) as LayerRange }));
  return validLayerMap(hops, model.num_layers);
}

/**
 * The route of a request for `model` (MVP: one pipeline per pool, every request goes through all
 * nodes, SPEC §5.5). The router (step 3.1) picks the pool; until then: the first pool (by id) with a
 * valid map for the model. null = unknown → warning; node shares go to reserve.
 */
export function currentRoute(db: Db, cfg: GpupoolConfig, model: ModelConfig, now = Date.now()): Route | null {
  const pools = [...new Set(freshNodes(db, cfg, null, now).map((n) => n.pool_id))].sort();
  for (const p of pools) {
    const map = poolLayerMap(db, cfg, p, model, now);
    if (map) return map;
  }
  console.warn(`route unknown for ${model.model_id}: no pool has a valid layer map from fresh heartbeats; node shares go to reserve`);
  return null;
}

/** GET /pools/:pool_id. The coordinator's node agent writes gpupool.pool from this. */
export function poolState(db: Db, cfg: GpupoolConfig, poolId: string, now = Date.now()): PoolStateResponse {
  const fresh = freshNodes(db, cfg, poolId, now);
  const members = fresh.map((n) => n.node_id).sort();
  for (const m of cfg.models) {
    const map = poolLayerMap(db, cfg, poolId, m, now);
    if (map) return { pool_id: poolId, models: [m.model_id], members, status: "ready", layer_map: map };
  }
  // No valid map: list the config models the fresh nodes report (so the listing still says what it loads).
  const models = [...new Set(fresh.map((n) => configModelFor(cfg, n.hb_model)?.model_id).filter((x): x is string => !!x))];
  return { pool_id: poolId, models, members, status: members.length > 0 ? "loading" : "offline", layer_map: null };
}
