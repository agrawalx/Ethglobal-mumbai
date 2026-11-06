import type { NodeListing, RouteHop } from "@shared/types";
import CrewScene from "../CrewScene";
import type { AgentId } from "../../data/crew";
import { fmtLayers, gpuShort, routeLabel, shortHash } from "../../lib/format";
import { nodeColor } from "../../lib/nodeColor";

/* The landing crew has sprites for the three pool laptops, so the mini crew is decorative here. */
const SPRITE: Record<string, AgentId> = { Rex: "pip", Mika: "milo", Nova: "wren" };

/** The pipeline that served the current request (spec §5.3 step 6: route captured per request). */
export default function RouteTrace({
  route,
  nodes,
  active,
  streaming,
}: {
  route: RouteHop[] | null;
  nodes: NodeListing[];
  /** Index of the hop holding the activations, -1 for none, -2 when the reply is done. */
  active: number;
  streaming: boolean;
}) {
  const find = (id: string) => nodes.find((n) => n.node_id === id);
  const label = (id: string) => {
    const n = find(id);
    return n ? gpuShort(n.gpu) : shortHash(id, 6, 4);
  };
  const highlight: AgentId[] = ["iris", ...(route ?? []).flatMap((h) => {
    const s = SPRITE[find(h.node_id)?.nickname ?? ""];
    return s ? [s] : [];
  })];

  return (
    <section className={`panel route-trace${streaming ? " is-streaming" : ""}`} aria-labelledby="route-h">
      <div className="panel-head">
        <h2 id="route-h" className="section-title">
          Route
        </h2>
        {route && <span className="faint mono">{route.length} hops</span>}
      </div>
      {route ? (
        <>
          <p className="route-line mono" aria-live="polite">
            {routeLabel(route, label)}
          </p>
          <div className="route-body">
            <ol className="laptops" aria-label="Laptops serving this request, in order">
              {route.map((h, i) => {
                const n = find(h.node_id);
                const done = i < active || active === -2;
                return (
                  <li key={`${h.node_id}-${i}`} className={`laptop${i === active ? " is-active" : ""}${done ? " is-done" : ""}`} style={{ ["--node" as string]: nodeColor(n?.nickname, i) }}>
                    <span className="laptop-screen" aria-hidden="true">
                      <span className="laptop-layers mono">{fmtLayers(h.layers)}</span>
                    </span>
                    <span className="laptop-base" aria-hidden="true" />
                    <span className="laptop-name">{n?.nickname ?? "node"}</span>
                    <span className="laptop-gpu faint mono">{n ? `${gpuShort(n.gpu)} · ${n.mem_gb} GB` : shortHash(h.node_id, 6, 4)}</span>
                    {i < route.length - 1 && <i className="laptop-link" aria-hidden="true" />}
                  </li>
                );
              })}
            </ol>
            <div className="route-crew" aria-hidden="true">
              <CrewScene variant="mini" highlight={highlight} />
            </div>
          </div>
        </>
      ) : (
        <p className="faint route-empty">Send a message to see which laptops serve it. Each one holds a slice of the model's layers.</p>
      )}
    </section>
  );
}
