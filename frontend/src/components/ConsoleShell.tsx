import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { Brand } from "./Shared";
import { Icon } from "./Icon";
import type { IconName } from "./Icon";
import { navigate } from "../lib/router";
import type { RouteName } from "../lib/router";
import { env } from "../config/env";
import { useFallbacks } from "../hooks/usePool";
import { useSession } from "../auth/context";
import { available, liveStarter } from "../lib/credits";
import { fmtNum } from "../lib/format";

const nav: { name: RouteName; to: string; label: string; icon: IconName }[] = [
  { name: "chat", to: "/chat", label: "Chat", icon: "chat" },
  { name: "account", to: "/account", label: "Account", icon: "user-check" },
  { name: "network", to: "/network", label: "Network", icon: "pod" },
  { name: "ledger", to: "/ledger", label: "Ledger", icon: "list" },
  { name: "payouts", to: "/payouts", label: "Payouts", icon: "coins" },
];

/** Header: credit balance + account menu when logged in, otherwise "Log in with World ID". */
function SessionButton() {
  const s = useSession();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent | KeyboardEvent) => {
      if (e instanceof KeyboardEvent ? e.key === "Escape" : !ref.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", close);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", close);
    };
  }, [open]);

  if (s.loading) return <span className="session-chip" aria-busy="true">…</span>;
  if (!s.me)
    return (
      <button className="button button-blue console-cta" onClick={() => s.openLogin()}>
        Log in with World ID <Icon name="user-check" size={14} />
      </button>
    );
  const b = s.me.balance;
  return (
    <div className="session-menu" ref={ref}>
      <button className="session-chip" aria-expanded={open} aria-haspopup="true" onClick={() => setOpen((o) => !o)} title="Your credits">
        <i className="status-dot" />
        <span>{fmtNum(available(b), 0)} cr</span>
      </button>
      {open && (
        <div className="session-pop" role="menu">
          <span className="mono-label">Account</span>
          <span className="mono faint">{s.me.account_id}</span>
          <span className="muted">
            {fmtNum(liveStarter(b), 1)} starter · {fmtNum(b.earned, 1)} earned
          </span>
          <button
            className="text-link"
            role="menuitem"
            onClick={() => {
              setOpen(false);
              navigate("/account");
            }}
          >
            Open account
          </button>
          <button
            className="text-link"
            role="menuitem"
            onClick={() => {
              setOpen(false);
              s.logout();
            }}
          >
            Log out
          </button>
        </div>
      )}
    </div>
  );
}

export default function ConsoleShell({
  current,
  children,
  wallet,
}: {
  current: RouteName;
  children: ReactNode;
  wallet?: ReactNode;
}) {
  const fallbacks = useFallbacks();
  return (
    <div className="console">
      <header className="console-header">
        <Brand />
        <nav className="console-nav" aria-label="Console navigation">
          {nav.map((item) => (
            <a
              key={item.name}
              href={item.to}
              className={item.name === current ? "is-current" : undefined}
              aria-current={item.name === current ? "page" : undefined}
            >
              <Icon name={item.icon} size={15} />
              {item.label}
            </a>
          ))}
        </nav>
        <div className="console-actions">
          {env.dataMode === "live" && fallbacks.length > 0 && (
            <span className="badge badge-mock" role="status" title={`The live backend did not answer, so these use demo data: ${fallbacks.join(", ")}`}>
              mock fallback
            </span>
          )}
          {env.dataMode === "mock" && (
            <span className="badge badge-mock" title="Seeded demo data. Set VITE_DATA_MODE=live for the real gateway.">
              mock data
            </span>
          )}
          {wallet}
          <SessionButton />
        </div>
      </header>
      <main className="console-main" id="console-main" tabIndex={-1}>
        {children}
      </main>
      <footer className="console-footer">
        <span>
          <span className="tiny-cross">+</span> Data sources:
        </span>
        <span className="badge badge-arkiv">Arkiv</span> pools, nodes, models ·
        <span className="badge badge-hcs">HCS</span> ledger events ·
        <span className="badge badge-hashscan">HashScan</span> x402 payments &amp; payouts
      </footer>
    </div>
  );
}

export function PageHead({
  label,
  title,
  sub,
  aside,
}: {
  label: string;
  title: ReactNode;
  sub?: ReactNode;
  aside?: ReactNode;
}) {
  return (
    <div className="page-head">
      <div>
        <span className="mono-label">
          <span className="tiny-cross">+</span> {label}
        </span>
        <h1>{title}</h1>
        {sub && <p>{sub}</p>}
      </div>
      {aside && <div className="page-head-aside">{aside}</div>}
    </div>
  );
}
