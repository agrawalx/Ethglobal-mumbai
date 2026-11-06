import type { NodeListing, Receipt } from "@shared/types";
import { Sheet } from "../Shared";
import SourceBadge from "../SourceBadge";
import CopyButton, { CodeBox } from "../console/CopyButton";
import { hashscanMessage, hashscanTx } from "../../lib/links";
import { env } from "../../config/env";
import { fmtHbar, fmtLayers, fmtNum, fmtTime, gpuShort, shortHash } from "../../lib/format";

const HASH_KEYS = new Set(["resp_hash", "prompt_hash", "x402_tx", "x402_payer"]);
const cr = (n: number) => `${fmtNum(n, 1)} cr`;

/** One request receipt (spec §5.3, §8.3). Hashes are shortened in the JSON view; Copy gives the exact JSON. */
export default function ReceiptSheet({ receipt, nodes, onClose }: { receipt: Receipt; nodes: NodeListing[]; onClose: () => void }) {
  const find = (id: string) => nodes.find((n) => n.node_id === id);
  const name = (id: string) => find(id)?.nickname ?? shortHash(id, 6, 4);
  const view = JSON.stringify(
    receipt,
    (k, v) => (typeof v === "string" && (HASH_KEYS.has(k) || k === "node_id") ? shortHash(v, 8, 6) : v),
    2,
  )
    // keep [start, end] layer ranges on one line
    .replace(/\[\s+(\d+),\s+(\d+)\s+\]/g, "[$1, $2]");
  const paid = receipt.pay_type === "x402" ? `${fmtHbar(receipt.x402_amount ?? "0")} (x402)` : cr(receipt.cost);
  const s = receipt.split;

  return (
    <Sheet title="Receipt" onClose={onClose}>
      <div className="receipt-sheet">
        <dl className="kv">
          <dt>Request</dt>
          <dd className="mono">{shortHash(receipt.req_id, 10, 4)}</dd>
          <dt>Model</dt>
          <dd className="mono">{receipt.model.split("/")[1] ?? receipt.model}</dd>
          <dt>Status</dt>
          <dd>{receipt.status === "ok" ? "settled" : receipt.status === "pending" ? "pending" : receipt.pay_type === "x402" && receipt.x402_tx ? "failed · payment settled before inference" : "failed · no credits charged"}</dd>
          <dt>Tokens</dt>
          <dd>
            {receipt.in_tokens} in / {receipt.out_tokens} out
          </dd>
          <dt>Paid</dt>
          <dd>{paid}</dd>
          <dt>Time</dt>
          <dd>{fmtTime(receipt.ts)}</dd>
          <dt>Ledger</dt>
          <dd>{receipt.hcs_seq != null ? <SourceBadge kind="hcs" seq={receipt.hcs_seq} href={hashscanMessage(env.hcsTopic, receipt.hcs_seq)} /> : <span className="faint">not on HCS yet</span>}</dd>
          {receipt.x402_tx && (
            <>
              <dt>Payment</dt>
              <dd>
                <SourceBadge kind="hashscan" href={hashscanTx(receipt.x402_tx)} title={receipt.x402_tx} />
              </dd>
            </>
          )}
          <dt>Prompt hash</dt>
          <dd className="mono">{shortHash(receipt.prompt_hash, 10, 6)}</dd>
          <dt>Reply hash</dt>
          <dd className="mono">{shortHash(receipt.resp_hash, 10, 6)}</dd>
        </dl>

        <div>
          <span className="mono-label">Route</span>
          <ol className="receipt-route">
            {receipt.route.map((h) => {
              const n = find(h.node_id);
              return (
                <li key={h.node_id}>
                  <span>{name(h.node_id)}</span>
                  <span className="mono faint">
                    {n ? gpuShort(n.gpu) : ""} {fmtLayers(h.layers)}
                  </span>
                </li>
              );
            })}
          </ol>
        </div>

        {s && (
          <div>
            <span className="mono-label">Split · 90% by layers, 5% burn, 5% reserve</span>
            <div className="table-wrap">
              <table className="table table-compact split-table">
                <thead>
                  <tr>
                    <th>Node</th>
                    <th className="num">Layers</th>
                    <th className="num">Credits</th>
                  </tr>
                </thead>
                <tbody>
                  {s.nodes.map((n) => (
                    <tr key={n.node_id}>
                      <td>{name(n.node_id)}</td>
                      <td className="num mono">{n.layers}</td>
                      <td className="num mono">{n.self ? <span className="faint">0 · own node → reserve</span> : cr(n.credits)}</td>
                    </tr>
                  ))}
                  <tr>
                    <td>Burn</td>
                    <td />
                    <td className="num mono">{cr(s.burn)}</td>
                  </tr>
                  <tr>
                    <td>Reserve</td>
                    <td />
                    <td className="num mono">{cr(s.reserve)}</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>
        )}

        <div>
          <span className="mono-label">JSON</span>
          <CodeBox code={view} copy={false} />
          <div className="receipt-copy">
            <CopyButton text={JSON.stringify(receipt, null, 2)} label="Copy full JSON" />
          </div>
        </div>
        <p className="faint">HCS holds hashes of your prompt and the reply, never the text. The gateway keeps the text for 7 days, then deletes it.</p>
      </div>
    </Sheet>
  );
}
