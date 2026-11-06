/* World ID login (spec §6). Lazy-loaded so the landing does not ship IDKit.
   Real flow: rp_context from the gateway → IDKit widget → result sent to
   /auth/world/verify unchanged → JWT. Without an RP (demo / no gateway yet) the
   sheet offers the four demo paths from §6.4 as a simulation. */
import { useEffect, useState } from "react";
import { IDKitRequestWidget, CredentialRequest, any } from "@worldcoin/idkit";
import type { IDKitErrorCodes } from "@worldcoin/idkit";
import { Sheet } from "../components/Shared";
import { Icon } from "../components/Icon";
import { api } from "../data";
import type { LoginResult, WorldRpContext } from "../data";
import { env } from "../config/env";
import { navigate } from "../lib/router";
import { fmtNum } from "../lib/format";
import { STARTER_CREDITS } from "../lib/credits";
import { useSession } from "./context";

type Sim = "new" | "existing" | "cancel" | "invalid";
type Outcome = { kind: "ok"; result: LoginResult } | { kind: "cancelled" } | { kind: "error"; message: string };

function fromIdkitError(code: IDKitErrorCodes): Outcome {
  if (code === "user_rejected") return { kind: "cancelled" };
  return { kind: "error", message: `World ID stopped with "${code}". Nothing changed. Try again.` };
}

export default function LoginSheet() {
  const s = useSession();
  const [rp, setRp] = useState<WorldRpContext | null | undefined>(undefined);
  const [rpError, setRpError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [sim, setSim] = useState<Sim>("new");
  const appId = env.worldAppId.startsWith("app_") ? (env.worldAppId as `app_${string}`) : null;

  useEffect(() => {
    let live = true;
    api.auth.rpContext().then(
      (c) => live && setRp(c),
      (e: Error) => {
        if (!live) return;
        setRp(null);
        setRpError(e.message);
      },
    );
    return () => {
      live = false;
    };
  }, []);

  const real = !!(rp && appId);
  const simulate = !real && env.dataMode === "mock";

  async function verify(result: unknown) {
    setBusy(true);
    setOutcome(null);
    try {
      const r = await api.auth.verify(result);
      s.login(r);
      setOutcome({ kind: "ok", result: r });
    } catch (e) {
      setOutcome({ kind: "error", message: (e as Error).message });
    } finally {
      setBusy(false);
    }
  }
  function done() {
    s.closeLogin();
    if (s.next) navigate(s.next);
  }

  return (
    <Sheet title="Log in with World ID" onClose={s.closeLogin}>
      <div className="login-body">
        <p className="muted">
          One human, one account. A new account gets {fmtNum(STARTER_CREDITS)} starter credits (valid for 14 days). Orb or Selfie Check both work.
        </p>

        {outcome?.kind === "ok" ? (
          <div className="world-card is-ok" role="status">
            <Icon name="user-check" size={22} />
            <div>
              {outcome.result.created ? (
                <>
                  <h3>Welcome. {fmtNum(STARTER_CREDITS)} starter credits.</h3>
                  <p className="muted">Your account is ready. The grant is recorded on the ledger.</p>
                </>
              ) : (
                <>
                  <h3>Already registered.</h3>
                  <p className="muted">This human already has an account. You are logged in to it. No new starter credits.</p>
                </>
              )}
              <p className="faint mono">{outcome.result.me.account_id}</p>
            </div>
          </div>
        ) : rp === undefined ? (
          <div className="skeleton" style={{ minHeight: 80 }} aria-busy="true" aria-label="Loading" />
        ) : real ? (
          <div className="world-actions">
            <button className="button button-blue" disabled={busy} onClick={() => setOpen(true)}>
              <Icon name="user-check" size={15} /> {busy ? "Checking…" : "Continue with World ID"}
            </button>
            <IDKitRequestWidget
              open={open}
              onOpenChange={setOpen}
              app_id={appId!}
              action={env.worldAction}
              rp_context={rp!}
              allow_legacy_proofs={false}
              constraints={any(CredentialRequest("proof_of_human"), CredentialRequest("selfie"))}
              onSuccess={(result) => verify(result)}
              onError={(code) => setOutcome(fromIdkitError(code))}
            />
          </div>
        ) : simulate ? (
          <div className="world-actions">
            <p className="faint">
              {appId ? "The gateway has no World ID relying party yet." : "No World ID app id is set (VITE_WORLD_APP_ID)."} Demo data: pick an outcome to simulate.
            </p>
            <div className="row wrap">
              <label className="sim">
                <span className="mono-label">Simulate</span>
                <select className="select" value={sim} onChange={(e) => setSim(e.target.value as Sim)}>
                  <option value="new">New human (account created)</option>
                  <option value="existing">Same human again (already registered)</option>
                  <option value="cancel">Cancel</option>
                  <option value="invalid">Invalid proof</option>
                </select>
              </label>
              <button
                className="button button-blue"
                disabled={busy}
                onClick={() => (sim === "cancel" ? setOutcome({ kind: "cancelled" }) : verify({ simulate: sim }))}
              >
                {busy ? "Checking…" : "Run World ID check"}
              </button>
            </div>
          </div>
        ) : (
          <div className="world-card is-bad" role="alert">
            <Icon name="shield" size={22} />
            <div>
              <h3>World login is not available</h3>
              <p className="muted">{rpError ?? (appId ? "The gateway did not return a signed request." : "No World ID app id is set (VITE_WORLD_APP_ID).")}</p>
            </div>
          </div>
        )}

        {outcome?.kind === "cancelled" && (
          <div className="world-card is-idle" role="status">
            <Icon name="back" size={22} />
            <div>
              <h3>Login cancelled</h3>
              <p className="muted">Nothing changed.</p>
            </div>
          </div>
        )}
        {outcome?.kind === "error" && (
          <div className="world-card is-bad" role="alert">
            <Icon name="shield" size={22} />
            <div>
              <h3>Couldn't verify</h3>
              <p className="muted">{outcome.message}</p>
            </div>
          </div>
        )}

        {outcome?.kind === "ok" && (
          <button className="button button-blue" onClick={done}>
            {s.next ? "Continue" : "Done"} <Icon name="arrow" size={15} />
          </button>
        )}
      </div>
    </Sheet>
  );
}
