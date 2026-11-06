/* /account (spec §12): balance, contribution ratio, payout address, my nodes, recent receipts.
   `?register=<node_id>&gpu=…&mem=…&sig=…` is the link that `gpupool-node init` prints: it opens a
   Confirm node card that calls POST /nodes/register (max 3 nodes per account, §6). */
import { useState } from "react";
import type { Me, NodeListing, Receipt } from "@shared/types";
import { PageHead } from "../components/ConsoleShell";
import ReceiptSheet from "../components/chat/ReceiptSheet";
import SourceBadge from "../components/SourceBadge";
import { Icon } from "../components/Icon";
import { Empty, ErrorBox, Loading, StatusPill } from "../components/console/Status";
import { api, SessionExpired } from "../data";
import { useSession } from "../auth/context";
import { useAsync } from "../hooks/useAsync";
import { useNetwork, useNow } from "../hooks/usePool";
import { useWallet } from "../wallet/useWallet";
import { MAX_NODES_PER_ACCOUNT, liveStarter } from "../lib/credits";
import { fmtAgo, fmtLayers, fmtLeft, fmtNum, gpuShort, shortHash } from "../lib/format";
import { hashscanMessage } from "../lib/links";
import { navigate } from "../lib/router";
import { env } from "../config/env";

const cr = (n: number) => fmtNum(n, 1);
type Link = import("../data/api").NodeLink;

function readLink(q: URLSearchParams): Link | null {
  const node_id = q.get("node_id");
  if (!node_id) return null;
  return { node_id, pool_id: q.get("pool_id") ?? "", gpu: q.get("gpu") ?? "",
    mem_gb: Number(q.get("mem_gb")), ts: Number(q.get("ts")), node_sig: q.get("node_sig") ?? "" };
}

function RegisterCard({ link, me, token, onDone }: { link: Link; me: Me; token: string; onDone: (me: Me) => void }) {
  const wallet = useWallet();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const payout = me.payout_address ?? wallet.address;
  const already = me.nodes.some((n) => n.node_id.toLowerCase() === link.node_id.toLowerCase());

  async function confirm() {
    if (!payout) return;
    setBusy(true);
    setError(null);
    try {
      onDone(await api.registerNode(token, { ...link, payout_address: payout }));
    } catch (e) {
      setError(e as Error);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="panel register-card" aria-labelledby="reg-h">
      <span className="mono-label">
        <Icon name="laptop" size={12} /> Registration link
      </span>
      <h2 id="reg-h">Confirm this node.</h2>
      <p className="muted">Your node agent made this link with its own key. Confirm to link the node to your account. It joins the pool listing and earns credits for the layers it serves.</p>
      <dl className="kv">
        <dt>Node key</dt>
        <dd className="mono" title={link.node_id}>
          {shortHash(link.node_id, 8, 6)}
        </dd>
        <dt>GPU</dt>
        <dd>{link.gpu ?? "—"}</dd>
        <dt>Memory</dt>
        <dd>{link.mem_gb ? `${link.mem_gb} GB` : "—"}</dd>
        <dt>Payout address</dt>
        <dd className="mono">{payout ? shortHash(payout, 8, 6) : <span className="faint">connect a wallet</span>}</dd>
      </dl>
      {!me.payout_address && <p className="faint">The payout address receives HBAR at each epoch. It is set from your connected wallet and recorded on the ledger.</p>}
      {error && <ErrorBox error={error} />}
      <div className="tile-actions">
        {already ? (
          <span className="pill pill-ok">already linked to this account</span>
        ) : payout ? (
          <button className="button button-blue" onClick={confirm} disabled={busy}>
            {busy ? "Linking…" : "Confirm node"} <Icon name="check" size={15} />
          </button>
        ) : (
          <button
            className="button button-blue"
            onClick={() => (wallet.hasInjected ? wallet.connectInjected().catch((e: Error) => setError(e)) : wallet.canUseDemo ? wallet.connectDemo() : setError(new Error("No browser wallet found. Install MetaMask.")))}
          >
            <Icon name="wallet" size={15} /> Connect wallet
          </button>
        )}
        <button className="button button-ghost" onClick={() => navigate("/account", { replace: true })}>
          Cancel
        </button>
      </div>
      <p className="faint">
        {me.nodes.length} of {MAX_NODES_PER_ACCOUNT} nodes used on this account.
      </p>
    </section>
  );
}

function NodesTable({ nodes, names }: { nodes: NodeListing[]; names: (id: string) => string }) {
  return (
    <div className="table-wrap">
      <table className="table">
        <thead>
          <tr>
            <th>Node</th>
            <th>GPU</th>
            <th>Status</th>
            <th>Layers</th>
            <th className="num">Reliability</th>
          </tr>
        </thead>
        <tbody>
          {nodes.map((n) => (
            <tr key={n.node_id}>
              <td>
                <span>{names(n.node_id)}</span>
                <span className="cell-sub mono faint">{shortHash(n.node_id, 6, 4)}</span>
              </td>
              <td>
                {gpuShort(n.gpu)} · {n.mem_gb} GB
              </td>
              <td>
                <StatusPill status={n.status} />
              </td>
              <td className="mono">{n.layers ? fmtLayers(n.layers) : <span className="faint">next pool start</span>}</td>
              <td className="num">
                <span className="mono">{n.reliability.toFixed(2)}</span>
                {n.success_rate != null && n.uptime_rate != null ? (
                  <span className="cell-sub faint">
                    0.7 × {n.success_rate.toFixed(2)} success + 0.3 × {n.uptime_rate.toFixed(2)} uptime
                  </span>
                ) : n.reliability === 0.8 ? (
                  <span className="cell-sub faint">new node, starts at 0.80</span>
                ) : null}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default function Account({ query }: { query: URLSearchParams }) {
  const session = useSession();
  const net = useNetwork();
  const now = useNow(10_000);
  const [sheet, setSheet] = useState<Receipt | null>(null);
  const [linked, setLinked] = useState<string | null>(null);
  const link = readLink(query);
  const token = session.token;
  const receipts = useAsync(() => (token ? api.myRequests(token) : Promise.resolve([])), [token, session.me?.balance.spent_total]);
  const me = session.me;
  const nodes = net?.nodes ?? [];
  const names = (id: string) => nodes.find((n) => n.node_id === id)?.nickname ?? me?.nodes.find((n) => n.node_id === id)?.nickname ?? shortHash(id, 6, 4);

  const head = <PageHead label="ACCOUNT · GATEWAY" title="Your account." sub={me ? <span className="mono">{me.account_id}</span> : "One human, one account, up to 3 nodes."} />;

  if (!token && !session.loading) {
    const here = `/account${query.toString() ? `?${query}` : ""}`;
    return (
      <>
        {head}
        {me?.incentives && <p className="muted">Vesting: {fmtNum(me.incentives.locked_mc / 1000)} credits · node limit {me.incentives.node_cap}{me.incentives.banned ? " · account banned" : ""}</p>}
        <section className="panel tile login-tile" aria-labelledby="acc-login-h">
          <span className="mono-label">
            <Icon name="user-check" size={12} /> World ID
          </span>
          <h2 id="acc-login-h">{link ? "Log in to link your node." : "Log in to see your account."}</h2>
          <p className="muted">{link ? "Your node agent printed this link. Log in with World ID first; the link stays open after login." : "Your balance, payout address, nodes and receipts live here."}</p>
          <div className="tile-actions">
            <button className="button button-blue" onClick={() => session.openLogin(here)}>
              Log in with World ID <Icon name="arrow" size={15} />
            </button>
          </div>
        </section>
      </>
    );
  }
  if (!me) {
    return (
      <>
        {head}
        {session.error ? <ErrorBox error={new Error(session.error)} retry={() => void session.reload()} /> : <Loading h={240} />}
      </>
    );
  }

  const b = me.balance;
  return (
    <>
      {head}
        {me?.incentives && <p className="muted">Vesting: {fmtNum(me.incentives.locked_mc / 1000)} credits · node limit {me.incentives.node_cap}{me.incentives.banned ? " · account banned" : ""}</p>}

      {linked && (
        <div className="world-card is-ok section-bottom" role="status">
          <Icon name="check" size={20} />
          <div>
            <h3>Node linked.</h3>
            <p className="muted">
              <span className="mono">{shortHash(linked, 8, 6)}</span> is now on your account. Its listing appears on the network once its agent renews it.
            </p>
          </div>
        </div>
      )}
      {link && !linked && token && (
        <RegisterCard
          link={link}
          me={me}
          token={token}
          onDone={() => {
            setLinked(link.node_id);
            void session.reload();
            navigate("/account", { replace: true });
          }}
        />
      )}

      <div className="stats section-gap">
        <div className="stat">
          <span className="mono-label">Starter credits</span>
          <p className="stat-value">{cr(liveStarter(b, now))}</p>
          <p className="stat-note">expires in {fmtLeft(b.starter_expires_at, now)} · spent first</p>
        </div>
        <div className="stat">
          <span className="mono-label">Earned credits</span>
          <p className="stat-value">{cr(b.earned)}</p>
          <p className="stat-note">{cr(b.earned_total)} earned in total</p>
        </div>
        <div className="stat">
          <span className="mono-label">Held</span>
          <p className="stat-value">{cr(b.held)}</p>
          <p className="stat-note">reserved for requests in flight</p>
        </div>
        <div className="stat">
          <span className="mono-label">Contribution ratio</span>
          <p className="stat-value">{me.ratio.toFixed(2)}</p>
          <p className="stat-note">earned ÷ max(spent, 1). A higher ratio goes first when the pool is busy.</p>
        </div>
      </div>

      <div className="grid grid-2 section-gap acc-grid">
        <section className="panel" aria-labelledby="payout-h">
          <div className="panel-head">
            <h2 id="payout-h" className="section-title">
              Payout address
            </h2>
            <span className="faint">Hedera testnet</span>
          </div>
          {me.payout_address ? (
            <>
              <p className="mono payout-addr">{me.payout_address}</p>
              <p className="faint">Your nodes' share of x402 income is paid here in HBAR at each epoch. Claim it on Payouts.</p>
              <button className="text-link" onClick={() => navigate("/payouts")}>
                Open payouts <Icon name="arrow" size={13} />
              </button>
            </>
          ) : (
            <p className="muted">Not set yet. Connect a wallet and link a node: the address is saved with the node and recorded on the ledger.</p>
          )}
        </section>

        <section className="panel" aria-labelledby="mynodes-h">
          <div className="panel-head">
            <h2 id="mynodes-h" className="section-title">
              My nodes
            </h2>
            <span className="faint">
              {me.nodes.length} / {MAX_NODES_PER_ACCOUNT}
            </span>
          </div>
          {me.nodes.length === 0 ? (
            <Empty>
              No nodes yet. Run <code className="mono">gpupool-node init</code> on your laptop and open the link it prints.
            </Empty>
          ) : (
            <NodesTable nodes={me.nodes} names={names} />
          )}
        </section>
      </div>

      <section className="panel section-gap" aria-labelledby="rc-h">
        <div className="panel-head">
          <h2 id="rc-h" className="section-title">
            Recent requests
          </h2>
          <button className="text-link" onClick={() => navigate("/chat")}>
            Open the playground <Icon name="arrow" size={13} />
          </button>
        </div>
        {receipts.error instanceof SessionExpired ? (
          <ErrorBox error={receipts.error} />
        ) : receipts.error && !receipts.data ? (
          <ErrorBox error={receipts.error} retry={receipts.reload} />
        ) : !receipts.data ? (
          <Loading h={120} />
        ) : receipts.data.length === 0 ? (
          <Empty>No requests yet. Ask the pool something in the playground.</Empty>
        ) : (
          <div className="table-wrap">
            <table className="table table-click">
              <thead>
                <tr>
                  <th>When</th>
                  <th>Model</th>
                  <th className="num">Tokens in / out</th>
                  <th className="num">Cost</th>
                  <th>Ledger</th>
                </tr>
              </thead>
              <tbody>
                {receipts.data.map((rc) => (
                  <tr key={rc.req_id} tabIndex={0} onClick={() => setSheet(rc)} onKeyDown={(e) => {
                      if (e.key !== "Enter" && e.key !== " ") return;
                      e.preventDefault();
                      setSheet(rc);
                    }} aria-label={`Open receipt ${rc.req_id}`}>
                    <td>{fmtAgo(rc.ts, now)}</td>
                    <td className="mono">{rc.model.split("/")[1] ?? rc.model}</td>
                    <td className="num mono">
                      {rc.in_tokens} / {rc.out_tokens}
                    </td>
                    <td className="num mono">{rc.status === "ok" ? `${cr(rc.cost)} cr` : <span className="faint">failed · 0</span>}</td>
                    <td>{rc.hcs_seq != null ? <SourceBadge kind="hcs" seq={rc.hcs_seq} href={hashscanMessage(env.hcsTopic, rc.hcs_seq)} /> : <span className="faint">pending</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
      {sheet && <ReceiptSheet receipt={sheet} nodes={nodes} onClose={() => setSheet(null)} />}
    </>
  );
}
