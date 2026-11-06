import { Component, lazy, Suspense } from "react";
import type { ReactNode } from "react";
import { BRAND } from "../config/brand";

const ParticleScene = lazy(() => import("./ParticleScene"));

// An unavailable animation chunk or WebGL setup must not remove the page.
class SceneBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <div className="scene-recovery">
        <div className="scene-fallback" aria-hidden="true"><div className="fallback-cube" /><span>{BRAND.short}</span></div>
        <button className="text-link" onClick={() => window.location.reload()}>Reload animation</button>
      </div>
    );
  }
}

export default function ParticleStage({ onPhase }: { onPhase: (phase: "cube" | "tree") => void }) {
  return (
    <SceneBoundary>
      <Suspense fallback={<div className="scene-loading"><span /></div>}>
        <ParticleScene onPhase={onPhase} />
      </Suspense>
    </SceneBoundary>
  );
}
