/* /payouts (spec §12, §10.5): the HBAR side of earning. AI agents pay per request with x402; each
   epoch the providers' 80% is split by layers served and posted to EpochPayout.sol as a Merkle root.
   This wallet's leaves come from GET /payouts/:address; closed epochs come from the signed
   epoch_closed events on the ledger. Claim is a wallet transaction (claim(epoch, amount, proof)). */
import { useState } from "react";
import { useWriteContract, usePublicClient } from "wagmi";
import type { Payout } from "@shared/types";
import { PageHead } from "../components/ConsoleShell";
import SourceBadge from "../components/SourceBadge";
import CopyButton from "../components/console/CopyButton";
import { Icon } from "../components/Icon";
import { Empty, ErrorBox, Loading } from "../components/console/Status";

import { useLedger, usePayouts, useNow } from "../hooks/usePool";
import { useWallet } from "../wallet/useWallet";
import { hederaTestnet } from "../wallet/config";
import { epochPayoutAbi } from "../abis/EpochPayout";
import { env } from "../config/env";
import { hashscanContract, hashscanTx } from "../lib/links";
import { fmtHbar, fmtLeft, fmtTime, shortHash } from "../lib/format";
import { hashscanMessage } from "../lib/links";
import { navigate } from "../lib/router";


function WalletGate() {
  const w = useWallet();
  const [err, setErr] = useState<string | null>(null);
  return (
    <section className="panel tile login-tile" aria-labelledby="wg-h">
      <span className="mono-label">
        <Icon name="wallet" size={12} /> Hedera testnet
      </span>
      <h2 id="wg-h">{w.wrongChain ? "Switch to Hedera testnet." : "Connect your payout wallet."}</h2>
      <p className="muted">Payouts go to the payout address of your nodes. Connect that wallet to see and claim your HBAR.</p>
      {err && <ErrorBox error={new Error(err)} />}
      <div className="tile-actions">
        {w.wrongChain ? (
          <button className="button button-blue" onClick={() => w.switchToHedera().catch((e: Error) => setErr(e.message))} disabled={w.switching}>
            {w.switching ? "Switching…" : "Switch network"}
          </button>
        ) : (
          <>
            {w.hasInjected && (
              <button className="button button-blue" onClick={() => w.connectInjected().catch((e: Error) => setErr(e.message))} disabled={w.connecting}>
                <Icon name="wallet" size={15} /> {w.connecting ? "Connecting…" : "Connect wallet"}
              </button>
            )}
            {w.canUseDemo && (
              <button className={`button ${w.hasInjected ? "button-ghost" : "button-blue"}`} onClick={w.connectDemo}>
                Use the demo wallet
              </button>
            )}
            {!w.hasInjected && !w.canUseDemo && <span className="faint">No browser wallet found. Install MetaMask.</span>}
          </>
        )}
      </div>
    </section>
  );
}

export default function Payouts() {
  const w = useWallet();
  const ready = w.connected && !w.wrongChain;
  const data = usePayouts(ready ? (w.address ?? undefined) : undefined);
  const now = useNow(1000);
  const write = useWriteContract();
  const publicClient = usePublicClient({ chainId: hederaTestnet.id });
  const [busy, setBusy] = useState<number | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [sent, setSent] = useState<Record<number, string>>({});

  const closed = useLedger("epoch_closed");
  const epochs = (closed.data ?? []).map((e) => ({
    epoch: Number(e.payload.epoch),
    start_ts: Number(e.payload.start_ts),
    end_ts: Number(e.payload.end_ts),
    total_tinybar: String(e.payload.total_tinybar ?? "0"),
    merkle_root: String(e.payload.merkle_root ?? ""),
    payouts: Array.isArray(e.payload.payouts) ? e.payload.payouts.length : null,
    hcs_seq: e.hcs_seq,
  }));
  const mine = data.data?.payouts ?? [];
  const last = epochs[0];
  const claimable = mine.filter((p) => !p.claimed && p.claimable === true && !p.swept && !sent[p.epoch]);
  const claimed = mine.filter((p) => p.claimed);
  const totalClaimable = claimable.reduce((s, p) => s + BigInt(p.amount_tinybar), 0n);

  async function claim(p: Payout) {
    setBusy(p.epoch);
    setError(null);
    try {
        if (!env.payoutAddr) throw new Error("No EpochPayout contract is set (VITE_PAYOUT_ADDR).");
        const hash = await write.mutateAsync({
          address: env.payoutAddr as `0x${string}`,
          abi: epochPayoutAbi,
          functionName: "claim",
          args: [BigInt(p.epoch), BigInt(p.amount_tinybar), p.proof],
          chainId: hederaTestnet.id,
        });
        if (!publicClient) throw new Error("Wallet RPC unavailable");
        const receipt = await publicClient.waitForTransactionReceipt({ hash });
        if (receipt.status !== "success") throw new Error("Claim reverted");
        setSent((s) => ({ ...s, [p.epoch]: hash }));
      data.reload();
    } catch (e) {
      setError(e as Error);
    } finally {
      setBusy(null);
    }
  }

  return (
    <>
      <PageHead
        label="PAYOUTS · EPOCHPAYOUT"
        title="Get paid in HBAR."
        sub="Credits pay for account requests. AI agents pay with x402 in HBAR instead. When an epoch closes, 80% of that income goes to the laptops that served it, by layers served, and each owner claims with a Merkle proof."
        aside={
          <span className="ledger-topic">
            <span className="faint">contract</span> <span className="mono">{env.payoutAddr ? shortHash(env.payoutAddr, 6, 4) : "not set"}</span> <SourceBadge kind="hashscan" href={hashscanContract(env.payoutAddr)} />
          </span>
        }
      />

      {!ready ? (
        <WalletGate />
      ) : data.error && !data.data ? (
        <ErrorBox error={data.error} retry={data.reload} />
      ) : !data.data ? (
        <Loading h={240} />
      ) : (
        <>
          <div className="stats">
            <div className="stat">
              <span className="mono-label">Last closed epoch</span>
              <p className="stat-value">{last ? `#${last.epoch}` : "—"}</p>
              <p className="stat-note">{last ? `${fmtHbar(last.total_tinybar)} to providers` : "none on the ledger yet"}</p>
            </div>
            <div className="stat">
              <span className="mono-label">Claimable</span>
              <p className="stat-value">{fmtHbar(totalClaimable.toString())}</p>
              <p className="stat-note">
                {claimable.length} posted epoch{claimable.length === 1 ? "" : "s"}
              </p>
            </div>
            <div className="stat">
              <span className="mono-label">Wallet</span>
              <p className="stat-value mono payout-wallet">{shortHash(w.address, 6, 4)}</p>
              <p className="stat-note">{w.isDemo ? "demo wallet" : "Hedera testnet"}</p>
            </div>
          </div>

          <section className="panel section-gap" aria-labelledby="claim-h">
            <div className="panel-head">
              <h2 id="claim-h" className="section-title">
                Your payouts
              </h2>
              <span className="faint">claim(epoch, amount, proof) · sends no HBAR</span>
            </div>
            {error && <ErrorBox error={error} />}
            {mine.length === 0 ? (
              <Empty>No payouts for this address yet. Payouts come from x402 requests that your nodes served.</Empty>
            ) : (
              <div className="table-wrap">
                <table className="table">
                  <thead>
                    <tr>
                      <th>Epoch</th>
                      <th className="num">Amount</th>
                      <th>Proof</th>
                      <th>Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {[...mine]
                      .sort((a, b) => b.epoch - a.epoch)
                      .map((p) => {
                        const tx = p.claim_tx ?? sent[p.epoch];
                        const posted = p.claimable === true && !p.swept;
                        return (
                          <tr key={p.epoch}>
                            <td className="mono">#{p.epoch}</td>
                            <td className="num mono">{fmtHbar(p.amount_tinybar)}</td>
                            <td className="mono faint">{p.proof.length} hashes</td>
                            <td>
                              {p.claimed || sent[p.epoch] ? (
                                <span className="row wrap">
                                  <span className="pill pill-ok">claimed</span>
                                  {tx && <SourceBadge kind="hashscan" href={hashscanTx(tx)} title={tx} />}
                                </span>
                              ) : posted ? (
                                <button className="button button-blue button-sm" onClick={() => claim(p)} disabled={busy != null}>
                                  {busy === p.epoch ? "Claiming…" : `Claim ${fmtHbar(p.amount_tinybar)}`}
                                </button>
                              ) : p.swept ? (
                                <span className="faint">swept back to the treasury</span>
                              ) : p.claimable_at ? (
                                <span className="faint">claimable in {fmtLeft(p.claimable_at, now)}</span>
                              ) : (
                                <span className="faint">waiting for the root</span>
                              )}
                              {p.post_tx && <SourceBadge kind="hashscan" href={hashscanTx(p.post_tx)} title={`postEpoch ${p.post_tx}`} />}
                            </td>
                          </tr>
                        );
                      })}
                  </tbody>
                </table>
              </div>
            )}
            {claimed.length > 0 && <p className="faint table-note">{claimed.length} claimed. Each claim is also an HCS event (payout_claimed).</p>}
          </section>


        </>
      )}

      <section className="panel section-gap" aria-labelledby="epochs-h">
        <div className="panel-head">
          <h2 id="epochs-h" className="section-title">
            Epochs
          </h2>
          <span className="faint">from epoch_closed events on HCS</span>
        </div>
        {closed.error && !closed.data ? (
          <ErrorBox error={closed.error} retry={closed.reload} />
        ) : !closed.data ? (
          <Loading h={120} />
        ) : epochs.length === 0 ? (
          <Empty>No epoch has closed in the recent ledger events.</Empty>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Epoch</th>
                  <th>Window</th>
                  <th className="num">To providers</th>
                  <th className="num">Payouts</th>
                  <th>Merkle root</th>
                  <th>Ledger</th>
                </tr>
              </thead>
              <tbody>
                {epochs.map((e) => (
                  <tr key={e.epoch}>
                    <td className="mono">#{e.epoch}</td>
                    <td className="nowrap">
                      {fmtTime(e.start_ts).slice(0, 5)}–{fmtTime(e.end_ts).slice(0, 5)}
                    </td>
                    <td className="num mono">{fmtHbar(e.total_tinybar)}</td>
                    <td className="num mono">{e.payouts ?? "—"}</td>
                    <td>
                      {e.merkle_root ? (
                        <span className="row">
                          <span className="mono">{shortHash(e.merkle_root, 8, 6)}</span>
                          <CopyButton text={e.merkle_root} compact />
                        </span>
                      ) : (
                        <span className="faint">—</span>
                      )}
                    </td>
                    <td>{e.hcs_seq != null ? <SourceBadge kind="hcs" seq={e.hcs_seq} href={hashscanMessage(env.hcsTopic, e.hcs_seq)} /> : <span className="faint">pending</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="faint table-note">
          The settler posts each root. Anyone can compare it with the epoch_closed event on HCS.{" "}
          <button className="text-link inline-link" onClick={() => navigate("/ledger?type=epoch_closed")}>
            See epoch_closed events <Icon name="arrow" size={12} />
          </button>
        </p>
      </section>
    </>
  );
}
