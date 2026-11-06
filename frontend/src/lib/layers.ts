/* Layer placement for the simulator (illustrative). Parallax does the real placement inside a pool;
   the gateway only checks that the reported ranges cover [0, num_layers) exactly once (SPEC §5.5). */
import type { RouteHop } from "@shared/types";

/** Memory a laptop keeps for the OS and KV cache before it takes layers (rough, for the sim). */
export const RESERVED_GB = 2;

/** Layers per node, proportional to usable memory, never more than a node can hold.
    Returns null when the pool cannot hold the model. Sums to `totalLayers` exactly. */
export function allocateLayers(memGb: number[], totalLayers: number, modelGb: number): number[] | null {
  if (memGb.length === 0 || totalLayers <= 0) return null;
  const gbPerLayer = modelGb / totalLayers;
  const usable = memGb.map((m) => Math.max(0, m - RESERVED_GB));
  const capacity = usable.map((u) => Math.floor(u / gbPerLayer));
  if (capacity.reduce((a, b) => a + b, 0) < totalLayers) return null;
  const total = usable.reduce((a, b) => a + b, 0);
  const exact = usable.map((u) => (u / total) * totalLayers);
  const out = exact.map((x, i) => Math.min(capacity[i], Math.floor(x)));
  // Hand out the rest by largest remainder, skipping full nodes.
  let left = totalLayers - out.reduce((a, b) => a + b, 0);
  while (left > 0) {
    let best = -1;
    for (let i = 0; i < out.length; i++) {
      if (out[i] >= capacity[i]) continue;
      if (best < 0 || exact[i] - out[i] > exact[best] - out[best]) best = i;
    }
    if (best < 0) return null;
    out[best]++;
    left--;
  }
  return out;
}

/** Counts → half-open pipeline stages in node order. Nodes with 0 layers are left out. */
export function toRoute(ids: string[], counts: number[]): RouteHop[] {
  let at = 0;
  const route: RouteHop[] = [];
  counts.forEach((c, i) => {
    if (c <= 0) return;
    route.push({ node_id: ids[i], layers: [at, at + c] });
    at += c;
  });
  return route;
}

/** True when the ranges cover [0, totalLayers) exactly once (the gateway's validity rule). */
export function coversExactly(route: RouteHop[], totalLayers: number) {
  const sorted = [...route].sort((a, b) => a.layers[0] - b.layers[0]);
  let at = 0;
  for (const h of sorted) {
    if (h.layers[0] !== at || h.layers[1] <= h.layers[0]) return false;
    at = h.layers[1];
  }
  return at === totalLayers;
}
