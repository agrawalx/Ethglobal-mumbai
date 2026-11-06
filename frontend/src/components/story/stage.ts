/* Geometry and data for the "How it works" pinned scroll story.
   One SVG stage (1000 × 560) that walks through the MVP flow (spec v0.1):
   install → World login → model split → Arkiv listing → request → credits → HBAR payout. */

export const VB_W = 1000;
export const VB_H = 560;

export const C = {
  accent: "#278cff",
  accentLt: "#a1d6ff",
  ok: "#8ecab3",
  warn: "#dfb69a",
  bad: "#ef6b6b",
  mut: "#9297a6",
  faint: "#606879",
  grid: "rgba(199,210,239,0.08)",
  line: "rgba(199,210,239,0.16)",
  text: "#f2f3f7",
  bg: "#030407",
} as const;

export type StoryNode = {
  key: string;
  name: string;
  gpu: string;
  memGb: number;
  color: string;
  x: number;
  y: number;
  /** Where it slides in from (offset). */
  from: [number, number];
  /** Half-open layer range in the pipeline, or null for the requester laptop. */
  layers: [number, number] | null;
};

/** Pool centre. The ring sits right of centre so the caption card (bottom-left) doesn't cover it. */
export const POD = { x: 610, y: 290, r: 150 };

export const MODEL = { id: "Qwen3-14B-FP8", layers: 40, gbPerLayer: 0.4 };

/** The three pool nodes (spec §1.2): 4060 + coordinator, M4, M5. Layers 11 / 20 / 9 of 40. */
export const NODES: StoryNode[] = [
  { key: "rex", name: "Rex", gpu: "RTX 4060 · 8 GB", memGb: 8, color: "#83caff", x: POD.x - POD.r, y: POD.y, from: [0, 0], layers: [0, 11] },
  { key: "mika", name: "Mika", gpu: "M4 · 16 GB", memGb: 16, color: "#b4a0ed", x: POD.x, y: POD.y - POD.r, from: [0, -140], layers: [11, 31] },
  { key: "nova", name: "Nova", gpu: "M5 · 16 GB", memGb: 16, color: "#dfb69a", x: POD.x + POD.r, y: POD.y, from: [180, 0], layers: [31, 40] },
];

/** The requester laptop, outside the pool (below the ring). */
export const ARI: StoryNode = { key: "ari", name: "Ari", gpu: "requester · outside the pool", memGb: 16, color: "#8ecab3", x: POD.x, y: POD.y + POD.r + 36, from: [0, 120], layers: null };

export const POOLED_GB = NODES.reduce((s, n) => s + n.memGb, 0); // 40
export const TOK_S = 18.4;

/* one example request (spec §8.1): Qwen3-14B factor 1.75, 412 in / 256 out, max_tokens 2048 */
export const FACTOR = 1.75;
export const IN_TOK = 412;
export const OUT_TOK = 256;
export const HOLD = FACTOR * (2048 + 0.2 * IN_TOK); // 3,728.2
export const COST = FACTOR * (OUT_TOK + 0.2 * IN_TOK); // 592.2
export const BALANCE = 10_000;
export const BURN = COST * 0.05;
export const RESERVE = COST * 0.05;
export const creditsFor = (n: StoryNode) => (n.layers ? (COST * 0.9 * (n.layers[1] - n.layers[0])) / MODEL.layers : 0);

export const EPOCH = 12;
export const CLAIM_HBAR = 0.42;

/* model bar (chapter 03) · route / cost / receipt cards reuse the same top band (y 14–70) */
/* kept inside x ≤ 790 so the top-right HUD never covers it */
export const BAR = { x: 290, y: 34, w: 500, h: 16 };
export const cellW = BAR.w / MODEL.layers;

/* epoch timer (chapter 07): a 10-minute dial around the pool, 0 at the top, clockwise */
export const CLOCK_R = 222;
export const EPOCH_MIN = 10;
export const minuteAngle = (m: number) => (m / EPOCH_MIN) * Math.PI * 2 - Math.PI / 2;
export const clockPoint = (m: number, r = CLOCK_R): [number, number] => [POD.x + Math.cos(minuteAngle(m)) * r, POD.y + Math.sin(minuteAngle(m)) * r];

/* pipeline links (chapters 04–06): Rex → Mika → Nova as quadratic curves */
type Pt = [number, number];
const [rex, mika, nova] = NODES;
export const LINKS: { a: Pt; c: Pt; b: Pt }[] = [
  { a: [rex.x + 30, rex.y - 30], c: [rex.x + 40, mika.y + 20], b: [mika.x - 50, mika.y + 10] },
  { a: [mika.x + 50, mika.y + 10], c: [nova.x - 40, mika.y + 20], b: [nova.x - 30, nova.y - 30] },
];
export const linkPath = (l: (typeof LINKS)[number]) => `M${l.a[0]},${l.a[1]}Q${l.c[0]},${l.c[1]} ${l.b[0]},${l.b[1]}`;

const quad = (a: number, c: number, b: number, u: number) => (1 - u) * (1 - u) * a + 2 * (1 - u) * u * c + u * u * b;
const lerp = (a: Pt, b: Pt, u: number): Pt => [a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u];

/** The gateway chip in the middle of the pool (Hedy). */
export const GATE: Pt = [POD.x, POD.y];
const ariTop: Pt = [ARI.x, ARI.y - 40];

/** One full request round trip, u in [0,1]: requester → gateway → Rex → Mika → Nova → gateway → requester. */
export function requestPoint(u: number): Pt {
  const segs: ((v: number) => Pt)[] = [
    (v) => lerp(ariTop, [GATE[0], GATE[1] + 16], v),
    (v) => lerp([GATE[0] - 40, GATE[1]], [rex.x + 48, rex.y - 6], v),
    (v) => [quad(LINKS[0].a[0], LINKS[0].c[0], LINKS[0].b[0], v), quad(LINKS[0].a[1], LINKS[0].c[1], LINKS[0].b[1], v)],
    (v) => [quad(LINKS[1].a[0], LINKS[1].c[0], LINKS[1].b[0], v), quad(LINKS[1].a[1], LINKS[1].c[1], LINKS[1].b[1], v)],
    (v) => lerp([nova.x - 48, nova.y - 6], [GATE[0] + 40, GATE[1]], v),
    (v) => lerp([GATE[0], GATE[1] + 16], ariTop, v),
  ];
  const k = Math.min(segs.length - 1, Math.floor(u * segs.length));
  return segs[k](u * segs.length - k);
}

/** Caption windows [fadeInStart, fullIn, fullOutStart, gone], same shape as the omniverse story. */
export const WINDOWS: [number, number, number, number][] = [
  [-0.02, 0.0, 0.09, 0.12],
  [0.13, 0.16, 0.23, 0.26],
  [0.27, 0.3, 0.37, 0.4],
  [0.41, 0.44, 0.49, 0.52],
  [0.53, 0.56, 0.63, 0.66],
  [0.67, 0.7, 0.77, 0.8],
  [0.81, 0.84, 1.0, 1.1],
];
