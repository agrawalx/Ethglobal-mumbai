/* /ledger (spec §12): the gateway's signed ledger events (GET /ledger/events), each also sent to
   the HCS topic (§10.2). Opening a row shows the payload and checks the message on the Hedera
   mirror node. */
import { Fragment, useState } from "react";
import type { LedgerEvent, LedgerType } from "@shared/types";
import { PageHead } from "../components/ConsoleShell";
import SourceBadge from "../components/SourceBadge";
import { CodeBox } from "../components/console/CopyButton";
import { Icon } from "../components/Icon";
import { Empty, ErrorBox, Loading } from "../components/console/Status";
import { api } from "../data";
import { HCS_TOPIC } from "../data/mock";
import { useAsync } from "../hooks/useAsync";
import { useLedger, useNow } from "../hooks/usePool";
import { env } from "../config/env";
import { hashscanMessage, hashscanTopic } from "../lib/links";
import { fmtAgo, fmtHbar, fmtNum, fmtTime, shortHash } from "../lib/format";
import { navigate } from "../lib/router";

const PAGE = 25;
const TYPES: LedgerType[] = ["account_created", "starter_grant", "request_settled", "x402_payment", "credits_expired", "payout_address_set", "epoch_closed", "payout_claimed"];
const PILL: Partial<Record<LedgerType, string>> = { request_settled: "pill-ok", payout_claimed: "pill-ok", x402_payment: "pill-warn", credits_expired: "pill-bad" };
const topic = env.hcsTopic || (api.mode === "mock" ? HCS_TOPIC : "");

const str = (v: unknown) => (v == null ? "" : String(v));
const num = (v: unknown) => Number(v ?? 0);

/** One line per event type, from its payload (§8.6). */
function summary(e: LedgerEvent) {
  const p = e.payload;
  switch (e.type) {
    case "account_created":
      return `new account · World ID ${str(p.credential) || "verified"}`;
    case "starter_grant":
      return `+${fmtNum(num(p.credits))} starter credits · 14 days`;
    case "request_settled": {
      const nodes = Object.keys((p.split as Record<string, number>) ?? {}).filter((k) => k !== "burn" && k !== "reserve").length;
      return `${fmtNum(num(p.cost), 1)} cr · ${nodes} nodes · ${str(p.model).split("/")[1] ?? str(p.model)}`;
    }
    case "x402_payment":
      return `${fmtHbar(str(p.amount_tinybar) || "0")} · ${str(p.model).split("/")[1] ?? str(p.model)}`;
    case "credits_expired":
      return `−${fmtNum(num(p.credits), 1)} starter credits expired`;
    case "payout_address_set":
      return `payout → ${shortHash(str(p.payout_address), 6, 4)}`;
    case "epoch_closed":
      return `epoch ${str(p.epoch)} · ${fmtHbar(str(p.total_tinybar) || "0")} · ${str(p.payouts)} payouts`;
    case "payout_claimed":
      return `epoch ${str(p.epoch)} · ${fmtHbar(str(p.amount_tinybar) || "0")} claimed`;
  }
}
const who = (e: LedgerEvent) => str(e.payload.account) || str(e.payload.payer) || str(e.payload.payout_address);

function MirrorCheck({ seq }: { seq: number | null }) {
  const check = useAsync(() => (seq != null && topic ? api.mirror(topic, seq) : Promise.resolve(null)), [seq]);
  if (seq == null) return <span className="faint">Not on HCS yet. The gateway writes to HCS after the request, without blocking it.</span>;
  if (!topic) return <span className="faint">No HCS topic is set (VITE_HCS_TOPIC).</span>;
  if (check.loading) return <span className="faint">Checking the mirror node…</span>;
  if (check.error) return <span className="mirror-bad">Mirror node check failed: {check.error.message}</span>;
  return check.data?.found ? (
    <span className="mirror-ok">
      ✓ on HCS #{seq}
      {check.data.consensus_ts && <span className="faint"> · consensus {check.data.consensus_ts}</span>}
    </span>
  ) : (
    <span className="faint">Not on HCS yet (#{seq} not found on the mirror node).</span>
  );
}

export default function Ledger({ query }: { query: URLSearchParams }) {
  const q = query.get("type");
  const type = TYPES.includes(q as LedgerType) ? (q as LedgerType) : undefined;
  const ledger = useLedger(type);
  const now = useNow(5000);
  const [page, setPage] = useState(0);
  const [open, setOpen] = useState<string | null>(null);

  const rows = ledger.data ?? [];
  const pages = Math.max(1, Math.ceil(rows.length / PAGE));
  const p = Math.min(page, pages - 1);
  const shown = rows.slice(p * PAGE, p * PAGE + PAGE);
  const toggle = (id: string) => setOpen((o) => (o === id ? null : id));

  return (
    <>
      <PageHead
        label="LEDGER · HEDERA HCS"
        title="Every credit, on the record."
        sub="The gateway signs each balance change and sends it to one public HCS topic. Open an event to check it on the Hedera mirror node."
        aside={
          <span className="ledger-topic">
            <span className="faint">topic</span> <span className="mono">{topic || "not set"}</span> <SourceBadge kind="hashscan" href={hashscanTopic(topic)} />
          </span>
        }
      />
      <section className="panel">
        <div className="panel-head">
          <span className="faint">{rows.length ? `${rows.length} events, newest first` : " "}</span>
          <label className="filters">
            <span className="sr-only">Event type</span>
            <select
              className="select"
              value={type ?? "all"}
              onChange={(e) => {
                setPage(0);
                setOpen(null);
                navigate(e.target.value === "all" ? "/ledger" : `/ledger?type=${e.target.value}`, { replace: true });
              }}
            >
              <option value="all">All events</option>
              {TYPES.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
          </label>
        </div>
        {ledger.error && !ledger.data ? (
          <ErrorBox error={ledger.error} retry={ledger.reload} />
        ) : !ledger.data ? (
          <Loading h={360} />
        ) : shown.length === 0 ? (
          <Empty>No {type ?? ""} events yet.</Empty>
        ) : (
          <div className="table-wrap">
            <table className="table table-click ledger-table">
              <thead>
                <tr>
                  <th>When</th>
                  <th>Type</th>
                  <th>Event</th>
                  <th>Account</th>
                  <th>HCS</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((e) => (
                  <Fragment key={e.id}>
                    <tr className={open === e.id ? "is-open" : undefined} onClick={() => toggle(e.id)}>
                      <td className="nowrap">
                        <button
                          className="row-toggle"
                          aria-expanded={open === e.id}
                          aria-controls={`ev-${e.id}`}
                          title={fmtTime(e.ts)}
                          onClick={(x) => {
                            x.stopPropagation();
                            toggle(e.id);
                          }}
                        >
                          <Icon name="chevron" size={11} /> {fmtAgo(e.ts, now)}
                        </button>
                      </td>
                      <td>
                        <span className={`pill ${PILL[e.type] ?? "pill-idle"} mono`}>{e.type}</span>
                      </td>
                      <td>{summary(e)}</td>
                      <td className="mono nowrap">{who(e) ? shortHash(who(e), 8, 4) : "—"}</td>
                      <td onClick={(x) => x.stopPropagation()}>{e.hcs_seq != null ? <SourceBadge kind="hcs" seq={e.hcs_seq} href={hashscanMessage(topic, e.hcs_seq)} /> : <span className="faint">pending</span>}</td>
                    </tr>
                    {open === e.id && (
                      <tr className="ledger-detail" id={`ev-${e.id}`}>
                        <td colSpan={5}>
                          <div className="ledger-detail-body">
                            <MirrorCheck seq={e.hcs_seq} />
                            <CodeBox code={JSON.stringify({ type: e.type, ...e.payload, gateway_sig: shortHash(e.gateway_sig, 10, 6) }, null, 2)} />
                          </div>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {rows.length > PAGE && (
          <div className="pager">
            <button className="button button-ghost button-sm" disabled={p === 0} onClick={() => setPage(p - 1)}>
              Newer
            </button>
            <span className="faint">
              {p * PAGE + 1}–{Math.min(rows.length, (p + 1) * PAGE)} of {rows.length}
            </span>
            <button className="button button-ghost button-sm" disabled={p >= pages - 1} onClick={() => setPage(p + 1)}>
              Older
            </button>
          </div>
        )}
      </section>
    </>
  );
}
