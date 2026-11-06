import { useEffect, useState } from "react";
import type { ProviderPool } from "@gpupool/shared";
import { Icon } from "../Icon";
import CopyButton, { CodeBox } from "../console/CopyButton";
import { ErrorBox } from "../console/Status";
import { useSession } from "../../auth/context";
import { providerApi } from "../../data/provider";
import { shortHash, fmtAgo } from "../../lib/format";

const stages: Record<string, string> = { waiting: "Waiting", installing: "Installing", downloading: "Downloading", prepared: "Prepared", starting: "Loading layers", online: "Serving", error: "Needs attention", stopped: "Stopped" };
const bytes = (n: number) => `${(n / 1e9).toFixed(1)} GB`;
export default function PoolSetup({ pool, refresh }: { pool: ProviderPool; refresh: () => void }) {
  const session = useSession();
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 3000);
    return () => window.clearInterval(timer);
  }, []);
  const own = pool.members.find(m => m.account_id === session.me?.account_id);
  const coordinator = pool.owner_account === session.me?.account_id;
  const [command, setCommand] = useState<{ command: string; expires_at: number } | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState<Error | null>(null);
  async function action(path: string) {
    setBusy(true); setError(null);
    try { await providerApi.manage(session.token!, pool.pool_id, path); refresh(); }
    catch (e) { setError(e as Error); }
    finally { setBusy(false); }
  }
  async function enroll() {
    setBusy(true); setError(null);
    try { setCommand(await providerApi.enroll(session.token!, pool.pool_id)); }
    catch (e) { setError(e as Error); }
    finally { setBusy(false); }
  }
  const approved = pool.members.filter(m => m.approved);
  const online = approved.filter(m => m.online).length;
  return <section className="panel provider-pool" aria-label={`${pool.name} setup`}>
    <div className="provider-pool-head"><div><span className="mono-label">{coordinator ? "YOUR POOL / COORDINATOR" : "YOUR POOL / MEMBER"}</span><h2>{pool.name}</h2><span className="faint mono">{pool.model}</span></div>
      <span role="status" aria-live="polite" className={`pill ${pool.discoverable ? "pill-ok" : pool.state === "stopped" ? "pill-idle" : "pill-warn"}`}>{pool.discoverable ? "Ready for requests" : pool.state === "ready" ? "Checking pool connection" : pool.state === "starting" ? "Starting pipeline" : pool.state === "stopped" ? "Stopped" : "Preparing"}</span></div>
    <div className="provider-pool-meta"><div><span className="mono-label">POOL ID</span><div className="provider-id mono">{pool.pool_id}<CopyButton text={pool.pool_id} compact /></div></div><div><span className="mono-label">LAPTOPS</span><p>{approved.length} / {pool.expected_members} approved · {online} serving</p></div></div>
    {!own?.approved ? <div className="provider-notice"><Icon name="shield" size={18} /><p>Your request is with the coordinator. The install command appears here when they approve it.</p></div> : pool.state === "stopped" ? <div className="provider-notice">The coordinator must restart this pool before helpers can reconnect.</div> : <div className="provider-install">
      <span className="mono-label">02 / CONNECT THIS LAPTOP</span><h3>One command. Your machine stays yours.</h3>
      <p className="muted">Run the helper in Terminal on the laptop you want to contribute. It installs the software, discovers Ethernet and prepares the model. Keep Terminal open while serving.</p>
      {command ? <><CodeBox code={command.command} /><p className="faint">Single use · expires {new Date(command.expires_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}. <button className="text-link" onClick={enroll} disabled={busy}>Generate a new command</button></p></> : <button className="button button-blue" onClick={enroll} disabled={busy}>{busy ? "Preparing command…" : own.node_id ? "Reconnect this laptop" : "Get install command"}<Icon name="arrow" size={14} /></button>}
      <p className="faint provider-requirements">Apple Silicon macOS or NVIDIA Linux · Python 3.10+ · Ethernet. Approve OS network/developer prompts if requested. Marketplace signing keys stay on the gateway.</p>
    </div>}
    <div className="provider-members-head"><span className="mono-label">03 / LIVE SETUP</span><span className="faint">Updates every 3 seconds</span></div>
    {coordinator && pool.state === "ready" && pool.members.some(m => !m.approved) && <p className="provider-notice">Approving another laptop pauses inference and starts a coordinated rebuild after the new member is prepared.</p>}
    <ol className="provider-members">{pool.members.map(member => {
      const seen = !!member.last_seen && now - member.last_seen < 30_000;
      const percentage = member.bytes_total > 0 ? Math.min(100, member.bytes_done / member.bytes_total * 100) : null;
      return <li key={member.id} className={member.stage === "error" ? "provider-member-error" : ""}>
        <div className={`provider-member-icon ${seen ? "is-connected" : ""}`}><Icon name={member.role === "coordinator" ? "pod" : "laptop"} size={20} /></div>
        <div className="provider-member-info"><strong>{member.account_id === session.me?.account_id ? "This owner" : shortHash(member.account_id, 7, 4)}<span className="faint">{member.role === "coordinator" ? "Coordinator" : "Member"}</span></strong><p>{!member.approved ? "Awaiting coordinator approval" : member.message || "Waiting for the local helper"}</p>
          {member.gpu && <span className="faint">{member.gpu} · {member.mem_gb?.toFixed(1)} GB</span>}
          {member.node_id && member.funding_status === "operator_required" && <div className="provider-gas"><span className="faint">Directory testnet gas needed unless this wallet is already funded:</span><span className="mono">{shortHash(member.node_id, 8, 6)} <CopyButton text={member.node_id} compact /></span><a className="text-link" href="https://hub.arkiv.network/faucet" target="_blank" rel="noreferrer">Arkiv faucet <Icon name="external" size={11} /></a></div>}
          {percentage !== null && member.stage === "downloading" && <><progress max={100} value={percentage} aria-label="Model transfer progress" /><span className="faint">{bytes(member.bytes_done)} / {bytes(member.bytes_total)}</span></>}
        </div>
        <div className="provider-member-status"><span className={`pill ${member.stage === "error" ? "pill-bad" : member.online ? "pill-ok" : "pill-idle"}`}>{member.approved ? member.last_seen && !seen ? "Disconnected" : member.stage === "online" && !member.online ? "Checking node" : stages[member.stage] : "Approval needed"}</span>{member.last_seen && <span className="faint">{fmtAgo(member.last_seen)}</span>}
          {coordinator && member.role !== "coordinator" && (!member.approved ? <button className="text-link" disabled={busy} onClick={() => action(`members/${member.id}/approve`)}>Approve</button> : <button className="text-link" disabled={busy} onClick={() => action(`members/${member.id}/revoke`)}>Remove</button>)}
        </div>
      </li>;
    })}</ol>
    {error && <ErrorBox error={error} />}
    <div className="provider-pool-footer"><span className="faint">{pool.coordinator_connected ? "Coordinator relay connected" : "Waiting for coordinator helper"}. Parallax assigns the transformer layers.</span>{coordinator && <div className="tile-actions"><button className="button button-ghost button-sm" disabled={busy} onClick={() => action(pool.state === "stopped" ? "restart" : "stop")}>{pool.state === "stopped" ? "Restart pool" : "Stop pool"}</button>{pool.state !== "stopped" && <button className="text-link" disabled={busy} onClick={() => action("restart")}>Retry setup</button>}</div>}</div>
  </section>;
}
