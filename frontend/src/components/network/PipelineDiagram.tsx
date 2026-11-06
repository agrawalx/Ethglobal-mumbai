import type { NodeListing, PoolListing } from "@shared/types";
import { fmtLayers, gpuShort } from "../../lib/format";
import { nodeColor } from "../../lib/nodeColor";

/** The pool's layer map as one bar, each slice coloured by the laptop serving it. */
export default function PipelineDiagram({ pool, nodes, totalLayers }: { pool: PoolListing; nodes: NodeListing[]; totalLayers: number }) {
  const find = (id: string) => nodes.find((n) => n.node_id === id);
  const total = totalLayers || pool.layer_map.reduce((m, h) => Math.max(m, h.layers[1]), 0);
  const ready = pool.status === "ready";
  return (
    <div className="pipelines">
      <div className={`pipeline${ready ? "" : " is-down"}`}>
        <div className="pipeline-head">
          <span className="mono">{pool.models.map((m) => m.split("/")[1] ?? m).join(", ")}</span>
          <span className="faint">{total} layers</span>
          <span className="pipeline-metric faint">load {Math.round(pool.load * 100)}%</span>
        </div>
        <div className="pipeline-bar" role="img" aria-label={pool.layer_map.map((h) => `${find(h.node_id)?.nickname ?? "missing node"} layers ${h.layers[0]} to ${h.layers[1]}`).join(", then ")}>
          {pool.layer_map.map((h, i) => {
            const n = find(h.node_id);
            const w = ((h.layers[1] - h.layers[0]) / total) * 100;
            return (
              <div className={`pipeline-seg${n ? "" : " is-down"}`} key={h.node_id} style={{ width: `${w}%`, ["--seg" as string]: nodeColor(n?.nickname, i) }}>
                <span className="pipeline-seg-name">{n?.nickname ?? "offline"}</span>
                <span className="pipeline-seg-sub mono">
                  {n ? gpuShort(n.gpu) : "?"} {fmtLayers(h.layers)}
                </span>
                {i < pool.layer_map.length - 1 && (
                  <i className="pipeline-arrow" aria-hidden="true">
                    →
                  </i>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
