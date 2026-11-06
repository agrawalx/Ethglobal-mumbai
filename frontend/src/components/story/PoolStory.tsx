import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { motion, useReducedMotion, useScroll, useSpring, useTransform } from "motion/react";
import type { MotionValue } from "motion/react";
import {
  ARI,
  BALANCE,
  BAR,
  BURN,
  C,
  CLAIM_HBAR,
  CLOCK_R,
  COST,
  EPOCH,
  EPOCH_MIN,
  GATE,
  HOLD,
  IN_TOK,
  LINKS,
  MODEL,
  NODES,
  OUT_TOK,
  POD,
  POOLED_GB,
  RESERVE,
  TOK_S,
  VB_H,
  VB_W,
  WINDOWS,
  cellW,
  clockPoint,
  creditsFor,
  linkPath,
  requestPoint,
} from "./stage";
import type { StoryNode } from "./stage";

/* ════════════════════════════════════════════════════════════════════════
   How it works: a pinned scroll story, adapted from the omniverse docs
   ScrollStory (sticky stage + crossfading captions + phase chip + HUD + rail).
   Seven chapters follow the MVP flow (spec v0.1), from install to payout.
   ════════════════════════════════════════════════════════════════════════ */

type Chapter = {
  phase: string;
  title: string;
  body: ReactNode;
  foot: string;
};

const CHAPTERS: Chapter[] = [
  {
    phase: "01 — INSTALL THE NODE AGENT",
    title: "Install the node agent.",
    body: "One command on your gaming laptop or Mac. It makes a node key and prints a link to register the node.",
    foot: "gpupool-node init · start · stop",
  },
  {
    phase: "02 — LOG IN WITH WORLD",
    title: "Log in with World ID.",
    body: "Open the link and prove you’re a real person. One human gets one account and up to 3 nodes, plus 10,000 starter credits.",
    foot: "World ID · Orb or Selfie Check · one account per nullifier",
  },
  {
    phase: "03 — THE MODEL ARRIVES",
    title: "Split one model three ways.",
    body: "Each laptop downloads the weights before it joins. Parallax gives each one a slice of layers that fits its memory. No single laptop can run this model alone.",
    foot: "Parallax · private network · weights pre-downloaded",
  },
  {
    phase: "04 — LISTED ON ARKIV",
    title: "The pool appears on Arkiv.",
    body: "Each laptop signs its own listing and renews it every 30 seconds. If a laptop stops, its listing expires by itself. No cleanup needed.",
    foot: "Arkiv · gpupool.node · gpupool.pool · 120 s expiry",
  },
  {
    phase: "05 — A REQUEST COMES IN",
    title: "Ask from any laptop.",
    body: "A user outside the pool sends a prompt. The gateway picks the pool from Arkiv and streams the answer back through all three laptops.",
    foot: "OpenAI-compatible API · route captured per request",
  },
  {
    phase: "06 — CREDITS SETTLE",
    title: "Credits split by work.",
    body: "The gateway holds the maximum cost, then settles the real cost. 90% goes to the nodes by layers served, 5% is burned and 5% goes to the reserve. The receipt goes to Hedera HCS.",
    foot: "HCS · request_settled · HashScan",
  },
  {
    phase: "07 — EPOCH PAYOUT",
    title: "Get paid in HBAR.",
    body: "AI agents pay per request with x402. At the end of each epoch, the providers’ share is posted to a contract, and each owner claims HBAR with a Merkle proof.",
    foot: "x402 on Hedera · EpochPayout.sol · claim on HashScan",
  },
];

const fmt = (v: number, d = 1) => v.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });

/* ── caption card (omniverse docs.tsx Caption) ─────────────────────────── */
function Caption({ t, win, num, chapter }: { t: MotionValue<number>; win: [number, number, number, number]; num: string; chapter: Chapter }) {
  const opacity = useTransform(t, win, [0, 1, 1, 0]);
  const y = useTransform(t, win, [28, 0, 0, -18]);
  return (
    <motion.div style={{ opacity, y }} className="story-caption">
      <p className="story-caption-num">{num}</p>
      <h3>{chapter.title}</h3>
      <p>{chapter.body}</p>
      <p className="story-caption-foot">{chapter.foot}</p>
    </motion.div>
  );
}

/* ── one laptop on the stage ───────────────────────────────────────────── */
function Laptop({ n, i, t }: { n: StoryNode; i: number; t: MotionValue<number> }) {
  const requester = !n.layers;
  // ch 01 (Rex) / ch 02 (Mika, Nova) / ch 05 (the requester): arrive
  const inA = requester ? 0.52 : i === 0 ? 0.0 : 0.15 + i * 0.018;
  const inB = requester ? 0.56 : i === 0 ? 0.04 : inA + 0.05;
  const arrive = useTransform(t, [inA, inB], [0, 1]);
  const dx = useTransform(arrive, (a) => n.from[0] * (1 - a));
  const dy = useTransform(arrive, (a) => n.from[1] * (1 - a));
  // ch 02: World ID badge (the requester logs in too, in ch 05)
  const bA = requester ? 0.55 : 0.2 + i * 0.01;
  const badge = useTransform(t, [bA, bA + 0.035], [0, 1]);
  // ch 03: memory fills as the layers load
  const loaded = n.layers ? (n.layers[1] - n.layers[0]) * MODEL.gbPerLayer : 0;
  const memW = useTransform(t, [0.31 + i * 0.01, 0.37 + i * 0.01], [0, (loaded / n.memGb) * 72]);
  const memO = useTransform(t, [0.29, 0.31], [0, 1]);
  const memText = useTransform(memW, (w) => `${fmt((w / 72) * n.memGb)} / ${n.memGb} GB`);
  const layerO = useTransform(t, requester ? [0.54, 0.57] : [0.36, 0.39], [0, 1]);
  // ch 04: health ring
  const healthO = useTransform(t, [0.45, 0.48], [0, 1]);
  // ch 06: credits earned for this request, by layers served
  const credits = creditsFor(n);
  const earnW = useTransform(t, [0.7, 0.76], [0, (credits / creditsFor(NODES[1])) * 92]);
  const earnText = useTransform(earnW, (w) => `+${fmt((w / 92) * creditsFor(NODES[1]))} cr`);
  const earnO = useTransform(t, [0.69, 0.71, 0.82, 0.85], [0, 1, 1, 0.35]);
  // ch 07: Mika's owner claims HBAR
  const claimO = useTransform(t, [0.95, 0.98], [0, 1]);

  return (
    <motion.g style={{ opacity: arrive, x: dx, y: dy }}>
      <g transform={`translate(${n.x} ${n.y})`}>
        {!requester && <motion.circle r={60} fill="none" stroke={C.ok} strokeWidth={1} className="story-pulse" style={{ opacity: healthO }} />}
        {/* screen + base */}
        <rect x={-48} y={-36} width={96} height={60} rx={7} fill="#070b14" stroke={n.color} strokeWidth={1.4} strokeDasharray={requester ? "4 3" : undefined} />
        <path d="M-58 28h116l-8 8h-100z" fill="#0b111d" stroke={n.color} strokeWidth={1.2} strokeLinejoin="round" />
        <text y={-18} textAnchor="middle" className="story-svg-name" fill={n.color}>
          {n.name}
        </text>
        {/* memory bar (pool nodes) */}
        {!requester && (
          <motion.g style={{ opacity: memO }}>
            <rect x={-36} y={-6} width={72} height={6} rx={3} fill="rgba(255,255,255,0.07)" />
            <motion.rect x={-36} y={-6} height={6} rx={3} width={memW} fill={n.color} />
            <motion.text y={12} textAnchor="middle" className="story-svg-micro" fill={C.mut}>
              {memText}
            </motion.text>
          </motion.g>
        )}
        {requester && (
          <text y={6} textAnchor="middle" className="story-svg-micro" fill={C.mut}>
            browser · agent
          </text>
        )}
        {/* World ID badge */}
        <g transform="translate(44 -34)">
          <motion.g style={{ opacity: badge, scale: badge }}>
            <circle r={9} fill={C.bg} stroke={C.ok} strokeWidth={1.3} />
            <path d="M-4 0l2.6 2.6L4-3" fill="none" stroke={C.ok} strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" />
          </motion.g>
        </g>
        {/* labels under the laptop */}
        <motion.text y={54} textAnchor="middle" className="story-svg-label" fill={C.mut} style={requester ? { opacity: layerO } : undefined}>
          {n.gpu}
        </motion.text>
        {!requester && (
          <motion.text y={70} textAnchor="middle" className="story-svg-label" fill={n.color} style={{ opacity: layerO }}>
            layers [{n.layers![0]}–{n.layers![1]})
          </motion.text>
        )}
        {!requester && (
          <motion.g style={{ opacity: earnO }}>
            <rect x={-46} y={80} width={92} height={5} rx={2.5} fill="rgba(255,255,255,0.07)" />
            <motion.rect x={-46} y={80} height={5} rx={2.5} width={earnW} fill={C.ok} />
            <motion.text y={100} textAnchor="middle" className="story-svg-micro" fill={C.ok}>
              {earnText}
            </motion.text>
          </motion.g>
        )}
        {n.key === "mika" && (
          <motion.g style={{ opacity: claimO }} transform="translate(0 -62)">
            <rect x={-104} y={-12} width={208} height={22} rx={11} fill={C.bg} stroke={C.ok} />
            <text y={3} textAnchor="middle" className="story-svg-micro" fill={C.ok}>
              +{CLAIM_HBAR} HBAR claimed · HashScan
            </text>
          </motion.g>
        )}
      </g>
    </motion.g>
  );
}

/* ── a request packet on its round trip (ch 05–06) ─────────────────────── */
function Packet({ t, k }: { t: MotionValue<number>; k: number }) {
  const u = useTransform(t, (v) => {
    const p = Math.max(0, (v - 0.555) / 0.245) * 2.4 + k / 3;
    return p - Math.floor(p);
  });
  const cx = useTransform(u, (x) => requestPoint(x)[0]);
  const cy = useTransform(u, (x) => requestPoint(x)[1]);
  const o = useTransform(t, [0.555, 0.575, 0.77, 0.8], [0, 1, 1, 0]);
  return <motion.circle r={4.5} cx={cx} cy={cy} fill={C.accentLt} style={{ opacity: o, filter: "drop-shadow(0 0 6px #278cff)" }} />;
}

/* ── one model-layer segment that flies from the bar to its laptop (ch 03) ─ */
function Segment({ n, t }: { n: StoryNode; t: MotionValue<number> }) {
  const [a, b] = n.layers!;
  const x0 = BAR.x + a * cellW;
  const w = (b - a) * cellW;
  const fly = useTransform(t, [0.315, 0.365], [0, 1]);
  const tx = useTransform(fly, (f) => (n.x - (x0 + w / 2)) * f);
  const ty = useTransform(fly, (f) => (n.y - 52 - BAR.y) * f);
  const sc = useTransform(fly, [0, 1], [1, 0.55]);
  const o = useTransform(t, [0.305, 0.32, 0.36, 0.38], [0, 1, 1, 0]);
  return (
    <motion.g style={{ x: tx, y: ty, opacity: o }}>
      <motion.rect x={x0} y={BAR.y} width={w} height={BAR.h} rx={3} fill={n.color} style={{ scale: sc }} />
    </motion.g>
  );
}

/* ── a coin flying between two points (ch 07) ──────────────────────────── */
function Coin({ t, from, to, win, label }: { t: MotionValue<number>; from: [number, number]; to: [number, number]; win: [number, number]; label: string }) {
  const f = useTransform(t, win, [0, 1]);
  const cx = useTransform(f, (v) => from[0] + (to[0] - from[0]) * v);
  const cy = useTransform(f, (v) => from[1] + (to[1] - from[1]) * v - Math.sin(v * Math.PI) * 40);
  const ty = useTransform(cy, (y) => y + 3.5);
  const o = useTransform(t, [win[0] - 0.01, win[0], win[1], win[1] + 0.015], [0, 1, 1, 0]);
  return (
    <motion.g style={{ opacity: o }}>
      <motion.circle r={9} cx={cx} cy={cy} fill="#0b111d" stroke={C.warn} strokeWidth={1.4} />
      <motion.text x={cx} y={ty} textAnchor="middle" className="story-svg-badge" fill={C.warn}>
        {label}
      </motion.text>
    </motion.g>
  );
}

function Hud({ t }: { t: MotionValue<number> }) {
  const o = useTransform(t, [0.2, 0.24], [0, 1]);
  const humans = useTransform(t, (v): string => (v < 0.555 ? "3 verified" : "4 verified"));
  const mem = useTransform(t, [0.27, 0.33], [0, POOLED_GB]);
  const memText = useTransform(mem, (v) => (v < 0.5 ? "—" : `${Math.round(v)} GB`));
  const layers = useTransform(t, [0.34, 0.38], [0, MODEL.layers]);
  const layersText = useTransform(layers, (v) => (v < 0.5 ? "—" : `${Math.round(v)} / ${MODEL.layers} placed`));
  const status = useTransform(t, (v): string => (v < 0.28 ? "forming" : v < 0.37 ? "loading" : v < 0.46 ? "joining" : "● ready"));
  const statusColor = useTransform(t, (v): string => (v < 0.46 ? C.warn : C.ok));
  const toks = useTransform(t, [0.58, 0.62], [0, TOK_S]);
  const toksText = useTransform(toks, (v) => (v < 0.05 ? "—" : `${v.toFixed(1)} tok/s`));
  const bal = useTransform(t, [0.71, 0.75], [BALANCE, BALANCE - COST]);
  const balText = useTransform(bal, (v) => `${fmt(v)} cr`);
  const payout = useTransform(t, (v): string => (v < 0.8 ? "—" : v < 0.9 ? `epoch ${EPOCH} · open` : v < 0.95 ? `epoch ${EPOCH} · posted` : `claimed ${CLAIM_HBAR} HBAR`));
  return (
    <motion.div style={{ opacity: o }} className="story-hud">
      <div>
        <span>humans</span>
        <motion.span>{humans}</motion.span>
      </div>
      <div>
        <span>pooled mem</span>
        <motion.span>{memText}</motion.span>
      </div>
      <div>
        <span>layers</span>
        <motion.span>{layersText}</motion.span>
      </div>
      <div>
        <span>pool</span>
        <motion.span style={{ color: statusColor }}>{status}</motion.span>
      </div>
      <div className="story-hud-split">
        <span>throughput</span>
        <motion.span>{toksText}</motion.span>
      </div>
      <div>
        <span>balance</span>
        <motion.span>{balText}</motion.span>
      </div>
      <div>
        <span>payout</span>
        <motion.span className="story-hud-ok">{payout}</motion.span>
      </div>
    </motion.div>
  );
}

/** On phones, crop the empty left side of the stage so the pool fills the width. */
function useNarrow() {
  const [narrow, setNarrow] = useState(() => matchMedia("(max-width: 639px)").matches);
  useEffect(() => {
    const mq = matchMedia("(max-width: 639px)");
    const change = () => setNarrow(mq.matches);
    mq.addEventListener("change", change);
    return () => mq.removeEventListener("change", change);
  }, []);
  return narrow;
}

/** A chip in the middle of the pool: the World ID check (ch 02), then the gateway (ch 05–07). */
function CenterChip({ t, win, label, sub, stroke, w = 120 }: { t: MotionValue<number>; win: [number, number, number, number]; label: string; sub?: string; stroke: string; w?: number }) {
  const o = useTransform(t, win, [0, 1, 1, 0]);
  const s = useTransform(t, [win[0], win[1]], [0.6, 1]);
  return (
    <motion.g style={{ opacity: o, scale: s }}>
      <rect x={GATE[0] - w / 2} y={GATE[1] - 16} width={w} height={sub ? 44 : 32} rx={16} fill={C.bg} stroke={stroke} />
      <text x={GATE[0]} y={GATE[1] + 4.5} textAnchor="middle" className="story-svg-code" fill={C.accentLt}>
        {label}
      </text>
      {sub && (
        <text x={GATE[0]} y={GATE[1] + 20} textAnchor="middle" className="story-svg-micro" fill={C.mut}>
          {sub}
        </text>
      )}
    </motion.g>
  );
}

/** Top band text card (route ch 05, cost ch 06, receipt ch 06). */
function TopCard({ t, win, children }: { t: MotionValue<number>; win: [number, number, number, number]; children: ReactNode }) {
  const o = useTransform(t, win, [0, 1, 1, 0]);
  const y = useTransform(t, [win[0], win[1]], [-10, 0]);
  return (
    <motion.g style={{ opacity: o, y }}>
      <rect x={290} y={14} width={500} height={56} rx={8} fill="#070a12" stroke={C.line} />
      {children}
    </motion.g>
  );
}

function Stage({ t }: { t: MotionValue<number> }) {
  const narrow = useNarrow();
  /* ch 01: the terminal types under Rex */
  const cmd = "$ gpupool-node init";
  const typed = useTransform(t, [0.005, 0.05], [0, cmd.length]);
  const typedText = useTransform(typed, (v) => cmd.slice(0, Math.round(v)));
  const line2O = useTransform(t, [0.06, 0.08], [0, 1]);
  const termO = useTransform(t, [0.02, 0.04, 0.13, 0.16], [0, 1, 1, 0]);

  /* ch 02: the pool ring */
  const ringP = useTransform(t, [0.15, 0.23], [0, 1]);
  const ringO = useTransform(t, [0.15, 0.17, 0.95, 1], [0, 0.9, 0.9, 0.5]);

  /* ch 03: model bar */
  const barO = useTransform(t, [0.27, 0.29, 0.36, 0.4], [0, 1, 1, 0]);
  const dl = useTransform(t, [0.28, 0.31], [0, BAR.w]);
  const dlText = useTransform(dl, (w) => `${MODEL.id} · ${MODEL.layers} layers · ${Math.round((w / BAR.w) * 100)}%`);

  /* ch 04: links + Arkiv listing card with its expiry ring */
  const linkP = useTransform(t, [0.41, 0.46], [0, 1]);
  const linkColor = useTransform(t, [0.43, 0.47], [C.faint, C.ok]);
  const cardO = useTransform(t, [0.44, 0.48, 0.62, 0.66], [0, 1, 1, 0]);
  const cardX = useTransform(t, [0.44, 0.49], [120, 0]);
  // drains for 30 s of its 120 s life, then the renewal refills it (four renewals across the chapter)
  const expiry = useTransform(t, (v) => {
    const p = Math.max(0, (v - 0.46) / 0.06) * 4;
    return 1 - (p - Math.floor(p)) * 0.25;
  });

  /* ch 06: cost hold → settle */
  const costV = useTransform(t, [0.69, 0.71, 0.73], [0, HOLD, COST]);
  const costText = useTransform(costV, (v) => (v < 1 ? "—" : `${fmt(v)} cr`));
  const costLabel = useTransform(t, (v): string => (v < 0.71 ? "hold (max_tokens 2048)" : "settled (256 out + 0.2 × 412 in) × 1.75"));
  const bpO = useTransform(t, [0.72, 0.745, 0.8, 0.83], [0, 1, 1, 0]);

  /* ch 07: the 10-minute epoch timer around the pool */
  const clockO = useTransform(t, [0.8, 0.82, 0.97, 1], [0, 1, 1, 0.6]);
  const arcP = useTransform(t, [0.82, 0.9], [0, 1]);
  const handM = useTransform(t, [0.82, 0.9], [0, EPOCH_MIN]);
  const handX = useTransform(handM, (m) => clockPoint(m, CLOCK_R - 18)[0]);
  const handY = useTransform(handM, (m) => clockPoint(m, CLOCK_R - 18)[1]);

  const [, mika] = NODES;
  return (
    <svg viewBox={narrow ? `284 0 ${VB_W - 284} ${VB_H}` : `0 0 ${VB_W} ${VB_H}`} preserveAspectRatio="xMidYMid meet" className="story-svg" aria-hidden="true">
      <defs>
        <radialGradient id="story-glow" cx="50%" cy="50%" r="50%">
          <stop offset="0" stopColor="#0d2a55" stopOpacity="0.5" />
          <stop offset="1" stopColor="#0d2a55" stopOpacity="0" />
        </radialGradient>
      </defs>
      <circle cx={POD.x} cy={POD.y} r={260} fill="url(#story-glow)" />

      {/* epoch dial (ch 07) */}
      <motion.g style={{ opacity: clockO }}>
        <circle cx={POD.x} cy={POD.y} r={CLOCK_R} fill="none" stroke={C.line} strokeWidth={1} strokeDasharray="2 6" />
        {Array.from({ length: EPOCH_MIN }, (_, m) => {
          const [x1, y1] = clockPoint(m, CLOCK_R - 4);
          const [x2, y2] = clockPoint(m, CLOCK_R + (m % 5 === 0 ? 8 : 4));
          return <line key={m} x1={x1} y1={y1} x2={x2} y2={y2} stroke={C.faint} strokeWidth={1} />;
        })}
        <motion.circle
          cx={POD.x}
          cy={POD.y}
          r={CLOCK_R}
          fill="none"
          stroke={C.accent}
          strokeWidth={5}
          strokeLinecap="round"
          style={{ pathLength: arcP, rotate: -90 }}
        />
        <text x={POD.x} y={POD.y - CLOCK_R - 18} textAnchor="middle" className="story-svg-micro" fill={C.accentLt}>
          epoch {EPOCH} · 0 min
        </text>
        <motion.line x1={POD.x} y1={POD.y} x2={handX} y2={handY} stroke={C.accentLt} strokeWidth={1.4} strokeLinecap="round" />
      </motion.g>

      {/* pool ring (ch 02) */}
      <motion.circle cx={POD.x} cy={POD.y} r={POD.r} fill="none" stroke={C.accent} strokeWidth={1} strokeDasharray="3 7" style={{ pathLength: ringP, opacity: ringO, rotate: -90 }} />

      {/* pipeline links (ch 04) */}
      {LINKS.map((l, i) => (
        <motion.path key={i} d={linkPath(l)} fill="none" stroke={linkColor} strokeWidth={2} strokeLinecap="round" style={{ pathLength: linkP }} />
      ))}

      {/* model bar (ch 03) */}
      <motion.g style={{ opacity: barO }}>
        <rect x={BAR.x} y={BAR.y} width={BAR.w} height={BAR.h} rx={3} fill="rgba(255,255,255,0.05)" stroke={C.line} />
        <motion.rect x={BAR.x} y={BAR.y} height={BAR.h} rx={3} width={dl} fill="rgba(39,140,255,0.35)" />
        {Array.from({ length: MODEL.layers - 1 }, (_, i) => (
          <line key={i} x1={BAR.x + (i + 1) * cellW} x2={BAR.x + (i + 1) * cellW} y1={BAR.y + 3} y2={BAR.y + BAR.h - 3} stroke="rgba(255,255,255,0.12)" />
        ))}
        <motion.text x={BAR.x + BAR.w / 2} y={BAR.y - 10} textAnchor="middle" className="story-svg-label" fill={C.mut}>
          {dlText}
        </motion.text>
      </motion.g>
      {NODES.map((n) => (
        <Segment key={n.key} n={n} t={t} />
      ))}

      {/* laptops: the pool, then the requester */}
      {NODES.map((n, i) => (
        <Laptop key={n.key} n={n} i={i} t={t} />
      ))}
      <Laptop n={ARI} i={3} t={t} />

      {/* centre chips: World ID check (ch 02), the gateway (ch 05–07), the epoch post (ch 07) */}
      <CenterChip t={t} win={[0.13, 0.16, 0.25, 0.28]} label="WORLD ID ✓" sub="1 human · 1 account" stroke={C.ok} w={150} />
      <CenterChip t={t} win={[0.53, 0.56, 0.895, 0.91]} label="HEDY · gateway" stroke={C.accent} />
      <CenterChip t={t} win={[0.9, 0.915, 0.99, 1.05]} label={`postEpoch(${EPOCH}, root)`} sub="EpochPayout.sol" stroke={C.warn} w={170} />

      {/* burn / reserve (ch 06) */}
      <motion.g style={{ opacity: bpO }}>
        <text x={GATE[0]} y={GATE[1] + 40} textAnchor="middle" className="story-svg-micro" fill={C.mut}>
          burn {fmt(BURN)} · reserve {fmt(RESERVE)}
        </text>
      </motion.g>

      {/* terminal (ch 01) */}
      <motion.g style={{ opacity: termO }}>
        <rect x={NODES[0].x - 100} y={NODES[0].y + 86} width={276} height={46} rx={6} fill="#02030a" stroke={C.line} />
        <motion.text x={NODES[0].x - 88} y={NODES[0].y + 105} className="story-svg-code" fill={C.accentLt}>
          {typedText}
        </motion.text>
        <motion.text x={NODES[0].x - 88} y={NODES[0].y + 122} className="story-svg-micro" fill={C.mut} style={{ opacity: line2O }}>
          key saved · open the link to register
        </motion.text>
      </motion.g>

      {/* packets: requester → gateway → Rex → Mika → Nova → back (ch 05–06) */}
      {[0, 1, 2].map((k) => (
        <Packet key={k} k={k} t={t} />
      ))}

      {/* x402 payment from an agent into the treasury, then Mika's HBAR claim (ch 07) */}
      <Coin t={t} from={[ARI.x + 40, ARI.y - 30]} to={[GATE[0] + 20, GATE[1] + 10]} win={[0.83, 0.87]} label="x402" />
      <Coin t={t} from={[GATE[0], GATE[1] - 18]} to={[mika.x, mika.y - 44]} win={[0.92, 0.955]} label="ℏ" />

      {/* Arkiv listing card (ch 04) */}
      <motion.g style={{ opacity: cardO, x: cardX }}>
        <rect x={736} y={430} width={252} height={92} rx={10} fill="#070a12" stroke={C.line} />
        <rect x={750} y={443} width={48} height={16} rx={8} fill="rgba(180,160,237,0.12)" stroke="rgba(180,160,237,0.4)" />
        <text x={774} y={454.5} textAnchor="middle" className="story-svg-badge" fill="#c9b8ff">
          ARKIV
        </text>
        <text x={808} y={455} className="story-svg-micro" fill={C.ok}>
          ● ready
        </text>
        <g transform="translate(962 452)">
          <circle r={10} fill="none" stroke="rgba(255,255,255,0.08)" strokeWidth={3} />
          <motion.circle r={10} fill="none" stroke={C.ok} strokeWidth={3} style={{ pathLength: expiry, rotate: -90 }} />
        </g>
        <text x={750} y={482} className="story-svg-name" fill={C.text}>
          gpupool.pool · pool-1
        </text>
        <text x={750} y={503} className="story-svg-micro" fill={C.mut}>
          3 nodes · renews every 30 s
        </text>
      </motion.g>

      {/* route (ch 05) */}
      <TopCard t={t} win={[0.565, 0.59, 0.64, 0.665]}>
        <text x={306} y={36} className="story-svg-code" fill={C.mut}>
          <tspan fill={C.ok}>route</tspan> Ari → Hedy → pool-1 · {TOK_S} tok/s
        </text>
        <text x={306} y={56} className="story-svg-code" fill={C.mut}>
          {NODES.map((n, i) => (
            <tspan key={n.key} fill={n.color}>
              {n.gpu.split(" ·")[0]} [{n.layers![0]}–{n.layers![1]}){i < NODES.length - 1 ? " → " : ""}
            </tspan>
          ))}
        </text>
      </TopCard>

      {/* cost (ch 06, first half) */}
      <TopCard t={t} win={[0.675, 0.69, 0.735, 0.75]}>
        <motion.text x={306} y={36} className="story-svg-code" fill={C.mut}>
          {costLabel}
        </motion.text>
        <motion.text x={306} y={57} className="story-svg-name" fill={C.text}>
          {costText}
        </motion.text>
      </TopCard>

      {/* receipt (ch 06, second half) */}
      <TopCard t={t} win={[0.75, 0.765, 0.81, 0.83]}>
        <text x={306} y={36} className="story-svg-code" fill={C.mut}>
          <tspan fill={C.ok}>receipt</tspan> 7f3a…c2 · {IN_TOK} in / {OUT_TOK} out · {fmt(COST)} cr · HCS #1877
        </text>
        <text x={306} y={56} className="story-svg-code" fill={C.mut}>
          {NODES.map((n, i) => (
            <tspan key={n.key} fill={n.color}>
              {n.name} {fmt(creditsFor(n))}
              {i < NODES.length - 1 ? " · " : ""}
            </tspan>
          ))}
          <tspan fill={C.faint}> · burn {fmt(BURN)} · reserve {fmt(RESERVE)}</tspan>
        </text>
      </TopCard>
    </svg>
  );
}

function StaticStory() {
  return (
    <div className="story-static">
      {CHAPTERS.map((c, i) => (
        <div className="story-caption story-caption-static" key={c.phase}>
          <p className="story-caption-num">
            0{i + 1} / 0{CHAPTERS.length}
          </p>
          <h3>{c.title}</h3>
          <p>{c.body}</p>
          <p className="story-caption-foot">{c.foot}</p>
        </div>
      ))}
    </div>
  );
}

export default function PoolStory() {
  const reduce = useReducedMotion();
  const ref = useRef<HTMLDivElement>(null);
  const { scrollYProgress } = useScroll({ target: ref, offset: ["start start", "end end"] });
  // wheel steps → continuous glide; every transform inherits the smoothing.
  const t = useSpring(scrollYProgress, { stiffness: 110, damping: 28, restDelta: 0.0001 });
  const phaseText = useTransform(t, (v): string => {
    const i = WINDOWS.findIndex((w) => v < w[3]);
    return CHAPTERS[i === -1 ? CHAPTERS.length - 1 : i].phase;
  });

  if (reduce) return <StaticStory />;

  return (
    <div ref={ref} className="story">
      <div className="story-stage">
        <Stage t={t} />

        <div className="story-phase">
          <p>How it works</p>
          <motion.p className="story-phase-current">{phaseText}</motion.p>
        </div>

        <Hud t={t} />

        <div className="story-rail" aria-hidden="true">
          <motion.div style={{ scaleY: t }} />
        </div>

        {CHAPTERS.map((c, i) => (
          <Caption key={c.phase} t={t} win={WINDOWS[i]} num={`0${i + 1} / 0${CHAPTERS.length}`} chapter={c} />
        ))}
      </div>
    </div>
  );
}
