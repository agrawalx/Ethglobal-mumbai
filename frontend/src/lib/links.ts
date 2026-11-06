import { env } from "../config/env";

/**
 * Explorer links. In mock mode every id is synthetic, so we return undefined:
 * badges render without a link (and say "demo data") instead of pointing a real
 * explorer at an id that does not exist.
 */
const HASHSCAN = "https://hashscan.io/testnet";
const live = () => env.dataMode === "live";

export const hashscanTx = (id: string | null | undefined) =>
  live() && id ? `${HASHSCAN}/transaction/${encodeURIComponent(id)}` : undefined;
export const hashscanContract = (addr: string | null | undefined) =>
  live() && addr ? `${HASHSCAN}/contract/${addr}` : undefined;
export const hashscanTopic = (topic: string | null | undefined) =>
  live() && topic ? `${HASHSCAN}/topic/${topic}` : undefined;
/** One HCS message on HashScan: topic + sequence number. */
export const hashscanMessage = (topic: string | null | undefined, seq: number | null | undefined) =>
  live() && topic && seq != null ? `${HASHSCAN}/topic/${topic}/message/${seq}` : undefined;
