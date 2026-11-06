import type { RouteHop } from "@shared/types";

/** 0x1234…abcd */
export function shortHash(h: string | null | undefined, head = 6, tail = 4) {
  if (!h) return "—";
  return h.length <= head + tail + 1 ? h : `${h.slice(0, head)}…${h.slice(-tail)}`;
}

/** Hedera EVM: contracts see tinybars (8 decimals). HBAR amounts in our schemas are tinybar integer strings. */
export const TINYBARS_PER_HBAR = 100_000_000;
export function hbar(tinybars: string | number | bigint) {
  return Number(tinybars) / TINYBARS_PER_HBAR;
}
export function fmtHbar(tinybars: string | number | bigint, digits = 2) {
  const v = hbar(tinybars);
  return `${v.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: Math.max(digits, 4) })} HBAR`;
}
export function toTinybars(hbarAmount: number) {
  return String(Math.round(hbarAmount * TINYBARS_PER_HBAR));
}

export function fmtAgo(ts: number, now = Date.now()) {
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 5) return "just now";
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

/** Time left until `ts`: "13 d 22 h", "5 h 10 m", "4 m", or "expired". */
export function fmtLeft(ts: number, now = Date.now()) {
  const m = Math.floor((ts - now) / 60_000);
  if (m <= 0) return "expired";
  const h = Math.floor(m / 60);
  const d = Math.floor(h / 24);
  if (d > 0) return `${d} d ${h % 24} h`;
  if (h > 0) return `${h} h ${m % 60} m`;
  return `${m} m`;
}

export function fmtTime(ts: number) {
  return new Date(ts).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

/** [a–b) half-open layer range */
export function fmtLayers(l: [number, number] | null | undefined) {
  return l ? `[${l[0]}–${l[1]})` : "—";
}

/** "M4 [0–20) → 4060 [20–40)" for any number of hops, using a node-id → short label lookup. */
export function routeLabel(route: RouteHop[], label: (nodeId: string) => string) {
  return route.map((h) => `${label(h.node_id)} ${fmtLayers(h.layers)}`).join(" → ");
}

export function fmtNum(n: number, digits = 0) {
  return n.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

/** "RTX 4060 Laptop" → "4060", "Apple M4" → "M4" */
export function gpuShort(gpu: string) {
  const m = gpu.match(/(RTX\s*)?(\d{4})/i);
  if (m) return m[2];
  const a = gpu.match(/M\d( (Pro|Max|Ultra))?/);
  return a ? a[0] : gpu;
}

/** Short display name for a node without a nickname: "M4 · 0xa4a4…a4a4". */
export function nodeName(node: { node_id: string; gpu?: string; nickname?: string } | undefined, id?: string) {
  if (node?.nickname) return node.nickname;
  const key = shortHash(node?.node_id ?? id ?? "", 6, 4);
  return node?.gpu ? `${gpuShort(node.gpu)} · ${key}` : key;
}

/** Credits from millicredits, for display. */
export const fmtMc = (mc: number, digits = 1) => fmtNum(mc / 1000, digits);
