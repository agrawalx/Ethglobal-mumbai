/* /network (spec §12, §11): the consumer directory, read from Arkiv through GET /network.
   Every pool (models, members, layer map, status, reliability = the pool's own success + uptime record, load) and every
   node (GPU, memory, layers, tok/s, status, reliability, owner). Pick a pool here to query it. */
import type { NodeListing, PoolListing } from "@shared/types";
import { PageHead } from "../components/ConsoleShell";
import SourceBadge from "../components/SourceBadge";
import PipelineDiagram from "../components/network/PipelineDiagram";
import LayerSim from "../components/sim/LayerSim";
import { Icon } from "../components/Icon";
import { Empty, ErrorBox, Loading, PoolPill, StatusPill } from "../components/console/Status";
import { useModels, useNetwork, useNow } from "../hooks/usePool";
import { fmtAgo, fmtLayers, fmtNum, shortHash } from "../lib/format";
import { nodeColor } from "../lib/nodeColor";
import { navigate } from "../lib/router";
import type { ModelOffer } from "../data";
import config from "../../../shared/config/gpupool.config.json";

const short = (id: string) => id.split("/")[1] ?? id;
const layersOf = (id: string | undefined) => config.models.find((m) => m.model_id === id)?.num_layers ?? 0;

function NodesTable({ nodes, layerOf }: { nodes: NodeListing[]; layerOf?: (id: string) => [number, number] | null }) {
  return (
    <div className="table-wrap">
      <table className="table">
        <thead>
          <tr>
            <th>Node</th>
            <th>GPU · memory</th>
            <th>Layers</th>
            <th className="num">Tok/s</th>
            <th>Status</th>
            <th className="num">Reliability</th>
            <th>Owner</th>
          </tr>
        </thead>
        <tbody>
          {nodes.map((n) => {
            const layers = layerOf?.(n.node_id) ?? n.layers;
            return (
              <tr key={n.node_id}>
                <td>
                  <span className="node-dot" style={{ ["--node" as string]: nodeColor(n.node_id) }} />
                  <span className="mono" title={n.node_id}>
                    {shortHash(n.node_id, 6, 4)}
                  </span>
                </td>
                <td>
                  {n.gpu} <span className="faint">· {n.mem_gb} GB</span>
                </td>
                <td className="mono">
                  {layers ? (
                    <>
                      {fmtLayers(layers)} <span className="faint">{layers[1] - layers[0]}</span>
                    </>
                  ) : (
                    <span className="faint">none yet</span>
                  )}
                </td>
                <td className="num mono">{n.tok_s ? n.tok_s.toFixed(1) : <span className="faint">—</span>}</td>
                <td>
                  <StatusPill status={n.status} />
                </td>
                <td className="num">
                  <span className="rep-bar" style={{ ["--rep" as string]: `${Math.round(n.reliability * 100)}%` }} />
                  <span className="mono">{n.reliability.toFixed(2)}</span>
                </td>
                <td className="mono faint" title={n.owner_account}>
                  {shortHash(n.owner_account, 8, 4)}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function PoolCard({ pool, nodes, offers }: { pool: PoolListing; nodes: NodeListing[]; offers: ModelOffer[] }) {
  const members = pool.members.map((id) => nodes.find((n) => n.node_id === id));
  const listed = members.filter((n): n is NodeListing => !!n);
  const pooledGb = listed.reduce((s, n) => s + n.mem_gb, 0);
  const model = pool.models[0];
  const factor = offers.find((o) => o.model.model_id === model)?.model.model_factor ?? config.models.find((m) => m.model_id === model)?.model_factor;
  const score = pool.reliability * (1 - pool.load);
  const usable = pool.status === "ready" && !pool.restarting;
  const layerOf = (id: string) => pool.layer_map.find((h) => h.node_id === id)?.layers ?? null;
  return (
    <article className="pool-card" aria-labelledby={`pool-${pool.pool_id}`}>
      <header className="pool-card-head">
        <div className="pool-id">
          <h3 id={`pool-${pool.pool_id}`} className="mono">
            {pool.pool_id}
          </h3>
          <PoolPill status={pool.status} />
          {pool.restarting && <span className="pill pill-warn">restarting</span>}
          {pool.route_dispute && (
            <span className="pill pill-warn" title="Node-reported sessions disagree with the scheduler's routes in the last hour. Flag only; no credits change.">
              route check flagged
            </span>
          )}
        </div>
        <div className="pool-models">
          {pool.models.map((m) => (
            <span key={m} className="mono">
              {short(m)}
            </span>
          ))}
          {factor != null && <span className="faint">×{factor} credits per token</span>}
        </div>
        <button
          className="button button-blue button-sm"
          disabled={!usable}
          title={usable ? "Open the playground pinned to this pool" : "The router skips pools that are not ready"}
          onClick={() => navigate(`/chat?model=${encodeURIComponent(model)}&pool=${encodeURIComponent(pool.pool_id)}`)}
        >
          Query this pool <Icon name="arrow" size={13} />
        </button>
      </header>
      <div className="stats pool-stats">
        <div className="stat">
          <span className="mono-label">Members</span>
          <p className="stat-value">{pool.members.length}</p>
          <p className="stat-note">{listed.length === pool.members.length ? "all listed on Arkiv" : `${listed.length} with a node listing`}</p>
        </div>
        <div className="stat">
          <span className="mono-label">Pooled memory</span>
          <p className="stat-value">
            {pooledGb}
            <small>GB</small>
          </p>
          <p className="stat-note">{layersOf(model) ? `${layersOf(model)} layers to place` : " "}</p>
        </div>
        <div className="stat">
          <span className="mono-label">Reliability</span>
          <p className="stat-value">{pool.reliability.toFixed(2)}</p>
          <p className="stat-note">pool success + uptime</p>
        </div>
        <div className="stat">
          <span className="mono-label">Load</span>
          <p className="stat-value">
            {Math.round(pool.load * 100)}
            <small>%</small>
          </p>
          <p className="stat-note">router score {score.toFixed(2)}</p>
        </div>
      </div>
      <PipelineDiagram pool={pool} nodes={nodes} totalLayers={layersOf(model)} />
      {pool.members.length > 0 && (
        <>
          <NodesTable nodes={[...listed].sort((a, b) => (layerOf(a.node_id)?.[0] ?? 1e9) - (layerOf(b.node_id)?.[0] ?? 1e9))} layerOf={layerOf} />
          {listed.length < pool.members.length && (
            <p className="faint table-note">
              No node listing for {members.map((n, i) => (n ? null : shortHash(pool.members[i], 6, 4))).filter(Boolean).join(", ")}. Its listing may have expired.
            </p>
          )}
        </>
      )}
    </article>
  );
}

export default function Network() {
  const net = useNetwork();
  const models = useModels();
  const now = useNow(1000);
  const offers = models.data ?? [];
  const pools = net?.pools ?? [];
  const nodes = net?.nodes ?? [];
  const inPool = new Set(pools.flatMap((p) => p.members));
  const loose = nodes.filter((n) => !inPool.has(n.node_id));
  const ready = pools.filter((p) => p.status === "ready").length;

  return (
    <>
      <PageHead
        label="ARKIV · DIRECTORY"
        title="Pick a pool."
        sub="Every pool and node, as their own Arkiv listings say right now. Listings renew every 30 seconds and disappear about 120 seconds after a machine stops."
        aside={
          net && (
            <span className="faint">
              Source: Arkiv <SourceBadge kind="arkiv" /> · updated {fmtAgo(net.updated_at, now)}
            </span>
          )
        }
      />

      {net?.error && <ErrorBox error={net.error} />}

      <div className="stats section-bottom">
        <div className="stat">
          <span className="mono-label">Pools</span>
          <p className="stat-value">
            {ready}
            <small>/ {pools.length} ready</small>
          </p>
        </div>
        <div className="stat">
          <span className="mono-label">Nodes</span>
          <p className="stat-value">
            {nodes.filter((n) => n.status === "online").length}
            <small>/ {nodes.length} online</small>
          </p>
        </div>
        <div className="stat">
          <span className="mono-label">Pooled memory</span>
          <p className="stat-value">
            {fmtNum(nodes.reduce((s, n) => s + n.mem_gb, 0))}
            <small>GB</small>
          </p>
        </div>
        <div className="stat">
          <span className="mono-label">Models served</span>
          <p className="stat-value">{offers.filter((o) => o.pools > 0).length}</p>
        </div>
      </div>

      <section className="panel" aria-labelledby="pools-h">
        <div className="panel-head">
          <h2 id="pools-h" className="section-title">
            Pools <SourceBadge kind="arkiv" />
          </h2>
          <span className="faint mono">gpupool.pool</span>
        </div>
        {!net ? (
          <Loading h={200} />
        ) : pools.length === 0 ? (
          <Empty>No pool is listed on Arkiv right now, so requests get HTTP 503 and cost nothing. A pool appears here once its members are online and their layer ranges cover the model.</Empty>
        ) : (
          <div className="pool-list">
            {[...pools]
              .sort((a, b) => b.reliability * (1 - b.load) - a.reliability * (1 - a.load))
              .map((p) => (
                <PoolCard key={p.pool_id} pool={p} nodes={nodes} offers={offers} />
              ))}
          </div>
        )}
        <p className="faint table-note">The router sends each request to the ready pool with the highest score = reliability × (1 − load). Parallax picks the nodes inside the pool. Pin a pool with "Query this pool".</p>
      </section>

      {loose.length > 0 && (
        <section className="panel section-gap" aria-labelledby="loose-h">
          <div className="panel-head">
            <h2 id="loose-h" className="section-title">
              Nodes not in a listed pool <SourceBadge kind="arkiv" />
            </h2>
            <span className="faint">waiting to form a pool, loading, or offline</span>
          </div>
          <NodesTable nodes={loose} />
        </section>
      )}

      <section className="panel section-gap" aria-labelledby="sim-h">
        <div className="panel-head">
          <h2 id="sim-h" className="section-title">
            How a pool splits a model
          </h2>
          <span className="faint">{pools.some((p) => p.layer_map.length) ? "live layer maps from Arkiv, or a simulated pool" : "simulated pool (no live layer map right now)"}</span>
        </div>
        <LayerSim pools={pools} nodes={nodes} preferLive={pools.some((p) => p.layer_map.length)} />
      </section>

      <div className="grid grid-2 section-gap net-tables">
        <section className="panel" aria-labelledby="models-h">
          <div className="panel-head">
            <h2 id="models-h" className="section-title">
              Models <SourceBadge kind="arkiv" />
            </h2>
            <span className="faint mono">gpupool.model</span>
          </div>
          {models.error && !models.data ? (
            <ErrorBox error={models.error} retry={models.reload} />
          ) : !models.data ? (
            <Loading h={120} />
          ) : models.data.length === 0 ? (
            <Empty>No model has a ready pool right now. /v1/models lists only models a live pool can serve.</Empty>
          ) : (
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>Model</th>
                    <th className="num">Layers</th>
                    <th className="num">Factor</th>
                    <th className="num">Pools</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {models.data.map(({ model: m, pools: n }) => (
                    <tr key={m.model_id}>
                      <td>
                        <span className="mono">{short(m.model_id)}</span>
                        <span className="cell-sub mono faint">
                          {m.size_gb} GB · {m.license}
                        </span>
                      </td>
                      <td className="num mono">{m.total_layers || "—"}</td>
                      <td className="num mono">×{m.model_factor}</td>
                      <td className="num mono">{n}</td>
                      <td>
                        <button className="text-link" onClick={() => navigate(`/chat?model=${encodeURIComponent(m.model_id)}`)}>
                          Chat <Icon name="arrow" size={12} />
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        <section className="panel" aria-labelledby="stats-h">
          <div className="panel-head">
            <h2 id="stats-h" className="section-title">
              Contributors <SourceBadge kind="arkiv" />
            </h2>
            <span className="faint mono">gpupool.account_stats</span>
          </div>
          {!net ? (
            <Loading h={120} />
          ) : net.stats.length === 0 ? (
            <Empty>No account stats yet.</Empty>
          ) : (
            <>
              <div className="table-wrap">
                <table className="table">
                  <thead>
                    <tr>
                      <th>Account</th>
                      <th className="num">Earned</th>
                      <th className="num">Spent</th>
                      <th className="num">Ratio</th>
                      <th className="num">Reliability</th>
                    </tr>
                  </thead>
                  <tbody>
                    {[...net.stats]
                      .sort((a, b) => b.ratio - a.ratio)
                      .map((s) => (
                        <tr key={s.account_id}>
                          <td className="mono">{shortHash(s.account_id, 8, 4)}</td>
                          <td className="num mono">{fmtNum(s.earned, 1)}</td>
                          <td className="num mono">{fmtNum(s.spent, 1)}</td>
                          <td className="num mono">{s.ratio.toFixed(2)}</td>
                          <td className="num mono">{s.reliability ? s.reliability.toFixed(2) : "—"}</td>
                        </tr>
                      ))}
                  </tbody>
                </table>
              </div>
              <p className="faint table-note">Pseudonymous account ids, updated every 10 minutes. Ratio = earned ÷ max(spent, 1). When a pool is busy, a higher ratio goes first.</p>
            </>
          )}
        </section>
      </div>
    </>
  );
}

