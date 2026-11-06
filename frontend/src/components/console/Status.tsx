import type { ReactNode } from "react";
import type { NodeStatus } from "@shared/types";

const map: Record<NodeStatus, [string, string]> = {
  ready: ["pill-ok", "ready"],
  online: ["pill-ok", "online"],
  loading: ["pill-warn", "loading"],
  offline: ["pill-idle", "offline"],
};
export function StatusPill({ status }: { status: NodeStatus }) {
  const [cls, label] = map[status];
  return <span className={`pill ${cls}`}>{label}</span>;
}

/** Pool listing status (gpupool.pool). */
export function PoolPill({ status }: { status: "ready" | "forming" | "offline" }) {
  const cls = status === "ready" ? "pill-ok" : status === "forming" ? "pill-warn" : "pill-bad";
  return <span className={`pill ${cls}`}>{status}</span>;
}

/** Shared loading / error / empty states for panels. */
export function Loading({ h = 120 }: { h?: number }) {
  return <div className="skeleton" style={{ minHeight: h }} aria-busy="true" aria-label="Loading" />;
}
export function ErrorBox({ error, retry }: { error: Error; retry?: () => void }) {
  return (
    <div className="error-box" role="alert">
      {error.message}
      {retry && (
        <button className="text-link" style={{ marginLeft: 12 }} onClick={retry}>
          Try again
        </button>
      )}
    </div>
  );
}
export function Empty({ children }: { children: ReactNode }) {
  return <div className="empty">{children}</div>;
}
