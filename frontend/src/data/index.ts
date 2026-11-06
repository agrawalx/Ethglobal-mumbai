/* The one data entry point the UI imports.
   mock → seeded fixtures. live → gateway + mirror node. Public reads the backend
   cannot serve yet (404, NotImplemented, network down, 5xx) fall back to the mock
   for that call only and flag `fallback`, so the shell shows a "mock fallback" badge.
   Login, session, chat, node linking, the mirror check and claims never fall back:
   a demo answer must never look like real money or a real proof. */
import { env } from "../config/env";
import { NotImplementedError } from "./api";
export { InsufficientCredits } from "../lib/credits";
export { NotImplementedError, PaymentRequired, SessionExpired } from "./api";
import type { PoolApi } from "./api";
import { mockApi } from "./mock";
import { liveApi } from "./live";

type Listener = (used: string[]) => void;
const fallbacks = new Set<string>();
const listeners = new Set<Listener>();
function noteFallback(what: string, err: unknown) {
  if (!fallbacks.has(what)) {
    console.warn(`[gpupool] live ${what} unavailable, using mock data:`, err instanceof Error ? err.message : err);
    fallbacks.add(what);
    listeners.forEach((l) => l([...fallbacks]));
  }
}
export function onFallback(l: Listener) {
  listeners.add(l);
  l([...fallbacks]);
  return () => {
    listeners.delete(l);
  };
}
const canFallBack = (e: unknown) => e instanceof NotImplementedError || e instanceof TypeError || (e instanceof Error && /HTTP 5\d\d/.test(e.message));

function wrap<T extends (...args: never[]) => Promise<unknown>>(name: string, live: T, mock: T): T {
  return (async (...args: Parameters<T>) => {
    try {
      return await live(...args);
    } catch (e) {
      if (!canFallBack(e)) throw e;
      noteFallback(name, e);
      return mock(...args);
    }
  }) as T;
}

function withFallback(): PoolApi {
  return {
    ...liveApi,
    models: wrap("models", liveApi.models, mockApi.models),
    request: wrap("receipts", liveApi.request, mockApi.request),
    network: wrap("network", liveApi.network, mockApi.network),
    ledger: wrap("ledger", liveApi.ledger, mockApi.ledger),
    payouts: wrap("payouts", liveApi.payouts, mockApi.payouts),
    subscribe(cb) {
      let stop = () => {};
      let switched = false;
      liveApi.network().then(
        () => {
          if (!switched) stop = liveApi.subscribe(cb);
        },
        (e) => {
          if (!canFallBack(e)) return;
          switched = true;
          noteFallback("network", e);
          stop = mockApi.subscribe(cb);
        },
      );
      return () => stop();
    },
  };
}

export const api: PoolApi = env.dataMode === "live" ? withFallback() : mockApi;
export type * from "./api";
