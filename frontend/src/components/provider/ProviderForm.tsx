import { useState } from "react";
import type { FormEvent } from "react";
import { Icon } from "../Icon";
import { ErrorBox } from "../console/Status";
import { useWallet } from "../../wallet/useWallet";
import { useSession } from "../../auth/context";
import { providerApi } from "../../data/provider";

export default function ProviderForm({ mode, models, done }: { mode: "create" | "join"; models: { model_id: string; size_gb: number }[]; done: () => void }) {
  const session = useSession(), wallet = useWallet();
  const [error, setError] = useState<Error | null>(null);
  const [busy, setBusy] = useState(false);
  const [address, setAddress] = useState("");
  const payout = address || session.me?.payout_address || wallet.address || "";
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setBusy(true); setError(null);
    try {
      if (mode === "create") await providerApi.create(session.token!, { name: String(form.get("name")), model: String(form.get("model")), expected_members: Number(form.get("count")), payout_address: payout });
      else await providerApi.join(session.token!, { pool_id: String(form.get("pool")).trim(), payout_address: payout });
      done();
    } catch (e) { setError(e as Error); }
    finally { setBusy(false); }
  }
  return <form className="provider-form panel" onSubmit={submit}>
    <div className="provider-section-label"><span className="mono-label">01 / YOUR {mode === "create" ? "POOL" : "INVITATION"}</span><span className="pill pill-ok"><Icon name="user-check" size={12} /> World verified</span></div>
    <h2>{mode === "create" ? "Make room for a bigger model." : "Bring your laptop to the pool."}</h2>
    {mode === "create" ? <div className="provider-fields">
      <label>Pool name<input name="name" required maxLength={60} placeholder="Friday GPU crew" autoComplete="off" /></label>
      <label>Model<select name="model" required defaultValue={models.find(m => m.model_id.includes("14B"))?.model_id ?? models[0]?.model_id}>{models.map(m => <option key={m.model_id} value={m.model_id}>{m.model_id} · {m.size_gb} GB</option>)}</select></label>
      <label>Laptops in this pool<input name="count" type="number" required min={2} max={16} defaultValue={4} /><span className="faint">Include this coordinator. Start when everyone is prepared.</span></label>
    </div> : <label>Pool ID<input name="pool" required placeholder="pool_…" autoComplete="off" spellCheck={false} /><span className="faint">Ask the coordinator for their Pool ID. They approve new members.</span></label>}
    <div className="provider-payout"><label>Your HBAR payout address<input value={payout} onChange={e => setAddress(e.target.value)} required pattern="0x[0-9a-fA-F]{40}" placeholder="0x…" spellCheck={false} autoComplete="off" /><span className="faint">A Hedera testnet EVM address. Each owner receives their own share.</span></label>
      {wallet.hasInjected && <button className="button button-ghost button-sm" type="button" disabled={wallet.connecting} onClick={() => wallet.connectInjected().catch(e => setError(e))}><Icon name="wallet" size={14} />{wallet.connecting ? "Connecting…" : "Use wallet"}</button>}</div>
    {error && <ErrorBox error={error} />}
    <button className="button button-blue" type="submit" disabled={busy || (mode === "create" && !models.length)}>{busy ? "Saving…" : mode === "create" ? "Create pool" : "Request to join"}<Icon name="arrow" size={15} /></button>
  </form>;
}
