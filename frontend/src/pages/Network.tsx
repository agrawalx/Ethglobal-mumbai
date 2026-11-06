/* /network (spec §12): the live directory on Arkiv. Pool listing, its layer map, the node
   listings (each renews every 30 s and expires 120 s after its last renewal), the model
   registry and per-account totals (gpupool.account_stats, §11.2). */
import { PageHead } from "../components/ConsoleShell";
import SourceBadge from "../components/SourceBadge";
import NodeCard from "../components/network/NodeCard";
import PipelineDiagram from "../components/network/PipelineDiagram";
import ExpiryRing from "../components/network/ExpiryRing";
import { Empty, ErrorBox, Loading, PoolPill } from "../components/console/Status";
import { useModels, useNetwork, useNow } from "../hooks/usePool";
import { fmtAgo, fmtNum, shortHash } from "../lib/format";

export default function Network() {
  const net = useNetwork();
  const models = useModels();
  const now = useNow(1000);
  const pool = net?.pools[0];
  const layersOf = (id: string | undefined) => models.data?.find((o) => o.model.model_id === id)?.model.total_layers ?? 0;
  const members = pool ? net!.nodes.filter((n) => pool.members.includes(n.node_id)) : [];
  const pooledGb = members.reduce((s, n) => s + n.mem_gb, 0);

  return (
    <>
      <PageHead
        label="ARKIV · DIRECTORY"
        title="The network."
        sub="Live listings from Arkiv. Each laptop renews its own listing every 30 seconds. If a laptop stops, its listing expires within 120 seconds."
        aside={net && <span className="faint">updated {fmtAgo(net.updated_at, now)}</span>}
      />

      {net?.error && <ErrorBox error={net.error} />}
      <section className="panel" aria-labelledby="pool-h">
        <div className="panel-head">
          <h2 id="pool-h" className="section-title">
            Pool <SourceBadge kind="arkiv" />
          </h2>
          <span className="faint mono">gpupool.pool</span>
        </div>
        {!net ? (
          <Loading h={160} />
        ) : !pool ? (
          <Empty>No pool is listed on Arkiv right now. Requests get HTTP 503 and cost nothing.</Empty>
        ) : (
          <>
            <div className="pool-head">
              <div className="pool-id">
                <h3 className="mono">{pool.pool_id}</h3>
                <PoolPill status={pool.status} />
              </div>
              <div className="stats pool-stats">
                <div className="stat">
                  <span className="mono-label">Members</span>
                  <p className="stat-value">
                    {members.length}
                    <small>/ {pool.members.length}</small>
                  </p>
                </div>
                <div className="stat">
                  <span className="mono-label">Pooled memory</span>
                  <p className="stat-value">
                    {pooledGb}
                    <small>GB</small>
                  </p>
                </div>
                <div className="stat">
                  <span className="mono-label">Reliability</span>
                  <p className="stat-value">{pool.reliability.toFixed(2)}</p>
                  <p className="stat-note">lowest node in the pool</p>
                </div>
                <div className="stat">
                  <span className="mono-label">Load</span>
                  <p className="stat-value">
                    {Math.round(pool.load * 100)}
                    <small>%</small>
                  </p>
                </div>
              </div>
              <ExpiryRing expiresAt={pool.expires_at} now={now} />
            </div>
            <PipelineDiagram pool={pool} nodes={net.nodes} totalLayers={layersOf(pool.models[0])} />
            <p className="faint table-note">Each request flows left to right through every laptop's slice of layers. Router score = reliability × (1 − load).</p>
          </>
        )}
      </section>

      <section className="panel section-gap" aria-labelledby="nodes-h">
        <div className="panel-head">
          <h2 id="nodes-h" className="section-title">
            Nodes <SourceBadge kind="arkiv" />
          </h2>
          <span className="faint mono">gpupool.node</span>
        </div>
        {!net ? (
          <Loading h={220} />
        ) : net.nodes.length === 0 ? (
          <Empty>No node listings. A node appears here when its agent runs gpupool-node start.</Empty>
        ) : (
          <div className="grid grid-3">
            {net.nodes.map((n) => (
              <NodeCard key={n.node_id} node={n} now={now} />
            ))}
          </div>
        )}
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
          ) : (
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>Model · MLX variant</th>
                    <th className="num">Size</th>
                    <th className="num">Factor</th>
                    <th>License</th>
                    <th>Served now</th>
                  </tr>
                </thead>
                <tbody>
                  {models.data.map(({ model: m, served }) => (
                    <tr key={m.model_id}>
                      <td>
                        <span className="mono">{m.model_id.split("/")[1] ?? m.model_id}</span>
                        <span className="cell-sub mono faint">{m.mlx_variant?.split("/")[1] ?? "no MLX variant"}</span>
                      </td>
                      <td className="num">{m.size_gb} GB</td>
                      <td className="num mono">×{m.model_factor}</td>
                      <td>{m.license}</td>
                      <td>{served ? <span className="pill pill-ok">✓ served</span> : <span className="pill pill-idle">no live pool</span>}</td>
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
              <p className="faint table-note">Pseudonymous account ids. Updated every 10 minutes. Ratio = earned ÷ max(spent, 1); a higher ratio goes first when the pool is busy.</p>
            </>
          )}
        </section>
      </div>
    </>
  );
}
