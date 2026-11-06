import { listModels, listNodes, listPools, listReadyPools, publicArkiv } from "@gpupool/arkiv";
import type { ArkivModel, ArkivNode, ArkivPool, ModelConfig, ModelsResponse, NetworkResponse, Route } from "@gpupool/shared";
import type { Config } from "./config.ts";
import type { Db } from "./db.ts";
import { configModelFor, poolLayerMap } from "./route.ts";
import { isRestarting, routeDispute, swappingMembers } from "./pools.ts";
import { coordinatorFor, coordinatorMap, urlHash as hashUrl } from "./formation.ts";
import type { PrivacyMode } from "./privacy.ts";

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

/**
 * Privacy (src/privacy.ts): `trusted-ends` = the first and last layers (closest to the prompt and the
 * answer) on trusted accounts' nodes; `trusted-all` = every layer. Other pools are skipped.
 */
export type SelectOptions = {
  privacy?: { mode: PrivacyMode; accounts: Set<string> };
  /** SPEC §16.3 routing preferences: only this pool (header x-gpupool-pool). */
  pin?: string;
  /** Only pools with reliability ≥ this (header x-gpupool-min-reliability). */
  minReliability?: number;
  /** The requester (private pools, SPEC §16.3). null = x402. */
  accountId?: string | null;
};

/** PRIVATE_POOLS env: pool → accounts allowed besides the pool's own node owners. */
function privatePools(cfg: Config): Record<string, string[]> {
  if (!cfg.env.PRIVATE_POOLS) return {};
  try { return JSON.parse(cfg.env.PRIVATE_POOLS) as Record<string, string[]>; }
  catch { console.warn("PRIVATE_POOLS is not valid JSON; no pool is private"); return {}; }
}

/** One private coordinator in the MVP. Arkiv publishes only its URL hash. */
export function createRouter(cfg: Config, db: Db, directory: Directory) {
  const active = new Map<string, number>();

  const ownerOf = (nodeId: string) => (db.prepare("SELECT account_id FROM nodes WHERE node_id = ?").get(nodeId) as { account_id: string } | undefined)?.account_id;

  async function candidates(model: ModelConfig, opts: SelectOptions = {}): Promise<SelectedPool[]> {
    const pools = await directory.readyPools(model.model_id);
    // SPEC §16.1 many pools: each pool has its own private coordinator (scheduler) URL.
    const coordinators = coordinatorMap(cfg);
    const now = Date.now();
    const minTs = now - cfg.net.router.pool_heartbeat_max_age_s * 1000;
    const out = new Map<string, SelectedPool>();
    for (const p of pools) {
      const coordinatorUrl = coordinatorFor(cfg, p.pool_id, coordinators);
      if (p.status !== "ready" || !p.models.includes(model.model_id) || p.coordinator_url_hash !== hashUrl(coordinatorUrl) || p.members.length === 0) continue;
      // SPEC §16.3: pinning, private pools, banned owners.
      if (opts.pin && p.pool_id !== opts.pin) continue;
      const priv = privatePools(cfg)[p.pool_id];
      if (priv) {
        const owners = (db.prepare("SELECT DISTINCT account_id FROM nodes WHERE pool_id = ?").all(p.pool_id) as { account_id: string }[]).map((r) => r.account_id);
        if (!opts.accountId || ![...priv, ...owners].includes(opts.accountId)) continue;
      }
      if ((db.prepare("SELECT count(*) AS n FROM nodes WHERE pool_id = ? AND banned = 1").get(p.pool_id) as { n: number }).n > 0) continue;
      // Post-MVP P5.5 / P5.7: never route into a pool that is restarting or has a swapping member.
      if (isRestarting(db, cfg, p.pool_id, now) || swappingMembers(db, cfg, p.pool_id, now).length > 0) continue;
      // Every advertised member must be registered in THIS pool, online, and fresh.
      const members = p.members.map((id) => db.prepare(
        `SELECT n.hb_ts, n.hb_online, n.hb_model, n.hb_hw_verified, r.score FROM nodes n
         LEFT JOIN node_reliability r ON r.node_id = n.node_id WHERE n.node_id = ? AND n.pool_id = ?`,
      ).get(id, p.pool_id) as { hb_ts: number | null; hb_online: number | null; hb_model: string | null; hb_hw_verified: number | null; score: number | null } | undefined);
      if (members.some((n) => !n || n.hb_hw_verified === 0 || !n.hb_online || n.hb_ts === null || n.hb_ts < minTs || n.hb_ts > now + 60_000 || configModelFor(cfg.net, n.hb_model)?.model_id !== model.model_id)) continue;
      const reliability = Math.min(...members.map((n) => n!.score ?? cfg.net.reliability.initial_score));
      const count = active.get(p.pool_id) ?? 0;
      const load = count / (count + 1);
      // Use signed heartbeats for the receipt, never the public listing's claimed layer map.
      if (opts.minReliability !== undefined && reliability < opts.minReliability) continue;
      const route = poolLayerMap(db, cfg.net, p.pool_id, model, now);
      if (opts.privacy) {
        // A privacy request needs a known route: every checked hop must belong to a trusted account.
        const hops = !route ? [] : opts.privacy.mode === "trusted-all" ? route : [route[0]!, route.at(-1)!];
        if (!route || !hops.every((h) => opts.privacy!.accounts.has(ownerOf(h.node_id) ?? ""))) continue;
      }
      out.set(p.pool_id, { poolId: p.pool_id, coordinatorUrl, route, score: reliability * (1 - load) });
    }
    return [...out.values()].sort((a, b) => b.score - a.score || a.poolId.localeCompare(b.poolId));
  }

  return {
    /** Best ready pool; `poolId` = only that pool; `exclude` = any pool but that one (P5.2 failover). */
    async select(model: ModelConfig, poolId?: string, exclude?: string, opts: SelectOptions = {}): Promise<SelectedPool | null> {
      const selected = (await candidates(model, opts)).find((p) => (!poolId || p.poolId === poolId) && p.poolId !== exclude) ?? null;
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
          return { ...pool, reliability: scores.length ? Math.min(...scores) : cfg.net.reliability.initial_score, load: count / (count + 1),
            route_dispute: routeDispute(db, cfg, pool.pool_id), restarting: isRestarting(db, cfg, pool.pool_id) };
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
