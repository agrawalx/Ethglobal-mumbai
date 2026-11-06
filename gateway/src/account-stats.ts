import { publicArkiv, walletArkiv, upsert, ttlFor } from "@gpupool/arkiv";
import { ArkivAccountStats } from "@gpupool/shared";
import type { Config } from "./config.ts";
import type { Db } from "./db.ts";
import { contributionRatio } from "./accounts.ts";
import { refreshReliability } from "./reliability.ts";

export type StatsWriter = (stats: ArkivAccountStats) => Promise<unknown>;

/** Lifetime contribution totals; never select or publish the World nullifier or private account fields. */
export function accountStatsSnapshot(db: Db, cfg: Config, now = Date.now()): ArkivAccountStats[] {
  refreshReliability(db, cfg, undefined, now);
  const rows = db.prepare(`SELECT a.id AS account_id, b.earned_total_mc AS earned_mc, b.spent_total_mc AS spent_mc,
    CASE WHEN count(n.node_id) = 0 THEN NULL ELSE min(coalesce(r.score, ?)) END AS reliability
    FROM accounts a JOIN balances b ON b.account_id = a.id
    LEFT JOIN nodes n ON n.account_id = a.id LEFT JOIN node_reliability r ON r.node_id = n.node_id
    GROUP BY a.id ORDER BY a.created_at, a.id`).all(cfg.net.reliability.initial_score) as { account_id: string; earned_mc: number; spent_mc: number; reliability: number | null }[];
  return rows.map((r) => ArkivAccountStats.parse({ type: "gpupool.account_stats", ...r, ratio: contributionRatio(r.earned_mc, r.spent_mc) }));
}

export function arkivStatsWriter(cfg: Config): StatsWriter {
  const env = { ARKIV_RPC_URL: cfg.env.ARKIV_RPC_URL, ARKIV_CHAIN_ID: cfg.env.ARKIV_CHAIN_ID,
    ARKIV_ACCESS_KEY: cfg.env.ARKIV_ACCESS_KEY, ARKIV_PRIVATE_KEY: cfg.env.ARKIV_PRIVATE_KEY };
  const pub = publicArkiv(env);
  const wallet = walletArkiv(env);
  return (stats) => upsert(pub, wallet, "accountStats", stats, ttlFor(cfg.net, "accountStats"));
}

/** One batch at startup, then every ten minutes; requests never wait for writes. */
export function startAccountStatsPublisher(db: Db, cfg: Config, write: StatsWriter, intervalMs = cfg.net.arkiv_account_stats_update_s * 1000) {
  let stopped = false;
  let running: Promise<{ written: number; failed: number }> | undefined;
  let timer: NodeJS.Timeout | undefined;
  const runOnce = (): Promise<{ written: number; failed: number }> => {
    if (stopped) return Promise.resolve({ written: 0, failed: 0 });
    if (running) return running;
    running = Promise.resolve().then(async () => {
      const stats = accountStatsSnapshot(db, cfg);
      let written = 0, failed = 0;
      for (const row of stats) {
        if (stopped) break;
        try { await write(row); written++; }
        catch (e) {
          failed++;
          console.error(`Arkiv account stats failed for ${row.account_id}: ${(e as Error).name}; retry at next scheduled batch`);
        }
      }
      return { written, failed };
    }).finally(() => { running = undefined; });
    return running;
  };
  const tick = async () => {
    if (stopped) return;
    try { await runOnce(); }
    catch (e) { console.error(`Arkiv account stats batch failed: ${(e as Error).name}`); }
    if (!stopped) timer = setTimeout(tick, intervalMs);
  };
  timer = setTimeout(tick, 0);
  return {
    runOnce,
    stop() { stopped = true; if (timer) clearTimeout(timer); return running ?? Promise.resolve(); },
  };
}
