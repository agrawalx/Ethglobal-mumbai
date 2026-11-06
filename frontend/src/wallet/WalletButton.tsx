import { Busy } from "../components/console/Status";
import { useState } from "react";
import { Icon } from "../components/Icon";
import { shortHash } from "../lib/format";
import { useWallet } from "./useWallet";

/** Header wallet chip: connect, wrong-network prompt, or the connected address. */
export default function WalletButton() {
  const w = useWallet();
  const [err, setErr] = useState<string | null>(null);
  if (w.connected && w.wrongChain)
    return (
      <button className="wallet-chip is-warn" onClick={() => w.switchToHedera().catch((e: Error) => setErr(e.message))} disabled={w.switching} title={err ?? "Your wallet is on another network"}>
        <Icon name="wallet" size={14} /> {w.switching ? <Busy>Switching…</Busy> : "Switch to Hedera"}
      </button>
    );
  if (w.connected)
    return (
      <button className="wallet-chip" onClick={w.disconnect} title="Disconnect">
        <i className="status-dot" />
        <span className="mono">{shortHash(w.address, 6, 4)}</span>
        {w.isDemo && <span className="wallet-demo">demo</span>}
      </button>
    );
  return (
    <button
      className="wallet-chip"
      disabled={w.connecting}
      title={err ?? undefined}
      onClick={() => {
        setErr(null);
        if (w.hasInjected) w.connectInjected().catch((e: Error) => setErr(e.message));
        else if (w.canUseDemo) w.connectDemo();
        else setErr("No browser wallet found. Install MetaMask.");
      }}
    >
      <Icon name="wallet" size={14} /> {w.connecting ? <Busy>Connecting…</Busy> : "Connect wallet"}
    </button>
  );
}
