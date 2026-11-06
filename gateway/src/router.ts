import { listModels, listNodes, listPools, listReadyPools, publicArkiv } from "@gpupool/arkiv";
import type { ArkivModel, ArkivNode, ArkivPool, ModelConfig, ModelsResponse, NetworkResponse, Route } from "@gpupool/shared";
import { keccak256, toBytes } from "viem";
import type { Config } from "./config.ts";
import type { Db } from "./db.ts";
import { configModelFor, poolLayerMap } from "./route.ts";

/** Read-only Arkiv boundary; tests inject readers without contacting the network. */
export type Directory = {
  models(): Promise<ArkivModel[]>;
  pools(): Promise<ArkivPool[]>;
  nodes(): Promise<ArkivNode[]>;
  readyPools(model: string): Promise<ArkivPool[]>;
};

export function arkivDirectory(cfg: Config): Directory {
  const pub = publicArkiv({ ARKIV_RPC_URL: cfg.env.ARKIV_RPC_URL, ARKIV_CHAIN_ID: cfg.env.ARKIV_CHAIN_ID, ARKIV_ACCESS_KEY: cfg.env.ARKIV_ACCESS_KEY });
  return { models: () => listModels(pub), pools: () => listPools(pub), nodes: () => listNodes(pub), readyPools: (model) => listReadyPools(pub, model) };
}

export type SelectedPool = { poolId: string; coordinatorUrl: string; route: Route | null; score: number };

/** One private coordinator in the MVP. Arkiv publishes only its URL hash. */
export function createRouter(cfg: Config, db: Db, directory: Directory) {
  const active = new Map<string, number>();
  const urlHash = keccak256(toBytes(cfg.env.POOL_COORDINATOR_URL));

  async function candidates(model: ModelConfig): Promise<SelectedPool[]> {
    const pools = await directory.readyPools(model.model_id);
    const now = Date.now();
    const minTs = now - cfg.net.router.pool_heartbeat_max_age_s * 1000;
    const out = new Map<string, SelectedPool>();
    for (const p of pools) {
      if (p.status !== "ready" || !p.models.includes(model.model_id) || p.coordinator_url_hash !== urlHash || p.members.length === 0) continue;
      // Every advertised member must be registered in THIS pool, online, and fresh.
      const members = p.members.map((id) => db.prepare(
        `SELECT n.hb_ts, n.hb_online, n.hb_model, r.score FROM nodes n
         LEFT JOIN node_reliability r ON r.node_id = n.node_id WHERE n.node_id = ? AND n.pool_id = ?`,
      ).get(id, p.pool_id) as { hb_ts: number | null; hb_online: number | null; hb_model: string | null; score: number | null } | undefined);
      if (members.some((n) => !n || !n.hb_online || n.hb_ts === null || n.hb_ts < minTs || n.hb_ts > now + 60_000 || configModelFor(cfg.net, n.hb_model)?.model_id !== model.model_id)) continue;
      const reliability = Math.min(...members.map((n) => n!.score ?? cfg.net.reliability.initial_score));
      const count = active.get(p.pool_id) ?? 0;
      const load = count / (count + 1);
      // Use signed heartbeats for the receipt, never the public listing's claimed layer map.
      out.set(p.pool_id, { poolId: p.pool_id, coordinatorUrl: cfg.env.POOL_COORDINATOR_URL,
        route: poolLayerMap(db, cfg.net, p.pool_id, model, now), score: reliability * (1 - load) });
    }
    return [...out.values()].sort((a, b) => b.score - a.score || a.poolId.localeCompare(b.poolId));
  }

  return {
    async select(model: ModelConfig, poolId?: string): Promise<SelectedPool | null> {
      const selected = (await candidates(model)).find((p) => !poolId || p.poolId === poolId) ?? null;
      if (selected && !selected.route) console.warn(`route unknown for ${model.model_id} in ${selected.poolId}: no valid heartbeat layer map; node shares go to reserve`);
      return selected;
    },
    /** Called only once payment preparation succeeds; released on completion/cancel/error. */
    start(poolId: string): () => void {
      active.set(poolId, (active.get(poolId) ?? 0) + 1);
      let released = false;
      return () => {
        if (released) return;
        released = true;
        const left = (active.get(poolId) ?? 1) - 1;
        if (left > 0) active.set(poolId, left);
        else active.delete(poolId);
      };
    },
    async network(): Promise<NetworkResponse> {
      const [pools, nodes] = await Promise.all([directory.pools(), directory.nodes()]);
      return {
        source: "arkiv",
        nodes,
        pools: pools.map((pool) => {
          const scores = pool.members.map((id) => {
            const local = db.prepare("SELECT r.score FROM nodes n JOIN node_reliability r ON r.node_id = n.node_id WHERE n.node_id = ? AND n.pool_id = ?").get(id, pool.pool_id) as { score: number } | undefined;
            return local?.score ?? nodes.find((n) => n.node_id === id && n.pool_id === pool.pool_id)?.reliability ?? cfg.net.reliability.initial_score;
          });
          const count = active.get(pool.pool_id) ?? 0;
          return { ...pool, reliability: scores.length ? Math.min(...scores) : cfg.net.reliability.initial_score, load: count / (count + 1) };
        }),
      };
    },
    async models(): Promise<ModelsResponse> {
      const catalog = await directory.models();
      const data: ModelsResponse["data"] = [];
      const seen = new Set<string>();
      for (const entry of catalog) {
        const model = cfg.model(entry.model_id);
        // Prices/layer counts remain admin configuration. Unknown catalog models cannot be served.
        if (!model || seen.has(model.model_id)) continue;
        seen.add(model.model_id);
        const pools = await candidates(model);
        if (!pools.length) continue;
        data.push({ id: model.model_id, object: "model", created: 0, owned_by: "gpupool",
          model_factor: model.model_factor, pools: pools.length, source: "arkiv" });
      }
      return { object: "list", data };
    },
  };
}
export type Router = ReturnType<typeof createRouter>;
