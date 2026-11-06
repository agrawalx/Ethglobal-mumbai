import { useEffect, useState } from "react";
import type { LedgerType } from "@shared/types";
import { api, onFallback } from "../data";
import type { NetworkSnapshot } from "../data";
import { useAsync } from "./useAsync";

/** Live pools, nodes and account stats (Arkiv, through the gateway) via the poll / mock ticker. */
export function useNetwork() {
  const [snap, setSnap] = useState<NetworkSnapshot>();
  useEffect(() => api.subscribe(setSnap), []);
  return snap;
}

export const useModels = () => useAsync(() => api.models(), [], { refreshMs: 15_000 });
export const useLedger = (type?: LedgerType) => useAsync(() => api.ledger({ type }), [type], { refreshMs: 10_000 });
export const usePayouts = (address: string | undefined) =>
  useAsync(() => (address ? api.payouts(address) : Promise.resolve(null)), [address], { refreshMs: 15_000 });

/** Which live calls are currently served by mock fallback (empty in mock mode). */
export function useFallbacks() {
  const [used, setUsed] = useState<string[]>([]);
  useEffect(() => onFallback(setUsed), []);
  return used;
}

/** Re-render every `ms` (for countdowns and "x s ago" labels). */
export function useNow(ms = 1000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(id);
  }, [ms]);
  return now;
}
