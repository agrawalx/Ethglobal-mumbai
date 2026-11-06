import type { NodeListing } from "@shared/types";
import { StatusPill } from "../console/Status";
import SourceBadge from "../SourceBadge";
import ExpiryRing from "./ExpiryRing";
import { fmtLayers, gpuShort, shortHash } from "../../lib/format";
import { nodeColor } from "../../lib/nodeColor";

/** One gpupool.node listing from Arkiv (spec §11.2). */
export default function NodeCard({ node, now }: { node: NodeListing; now: number }) {
  return (
    <article className="node-card" style={{ ["--node" as string]: nodeColor(node.nickname) }}>
      <header>
        <div>
          <h3>{node.nickname ?? shortHash(node.node_id, 6, 4)}</h3>
          <span className="faint">{node.gpu}</span>
        </div>
        <ExpiryRing expiresAt={node.expires_at} now={now} />
      </header>
      <dl className="kv node-kv">
        <dt>Memory</dt>
        <dd>{node.mem_gb} GB</dd>
        <dt>Layers</dt>
        <dd className="mono">{node.layers ? `${gpuShort(node.gpu)} ${fmtLayers(node.layers)}` : "—"}</dd>
        <dt>Throughput</dt>
        <dd>{node.tok_s ? `${node.tok_s.toFixed(1)} tok/s` : "—"}</dd>
        <dt>Reliability</dt>
        <dd>
          <span className="rep-bar" style={{ ["--rep" as string]: `${Math.round(node.reliability * 100)}%` }} />
          {node.reliability.toFixed(2)}
        </dd>
        <dt>Owner</dt>
        <dd className="mono">{shortHash(node.owner_account, 8, 4)}</dd>
        <dt>Node key</dt>
        <dd className="mono" title={node.node_id}>
          {shortHash(node.node_id, 6, 4)}
        </dd>
      </dl>
      <footer>
        <StatusPill status={node.status} />
        <span className="faint mono">{node.pool_id}</span>
        <SourceBadge kind="arkiv" />
      </footer>
    </article>
  );
}
