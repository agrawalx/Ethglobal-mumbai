/** One inference slot per pool. Highest ratio first; equal ratios retain arrival order. */
export function createPoolQueue() {
  type Waiter = { ratio: number; grant(): void };
  const pools = new Map<string, { busy: boolean; waiting: Waiter[] }>();
  return {
    acquire(poolId: string, ratio: number, signal: AbortSignal): Promise<() => void> {
      if (signal.aborted) return Promise.reject(new DOMException("Request cancelled", "AbortError"));
      let pool = pools.get(poolId);
      if (!pool) { pool = { busy: false, waiting: [] }; pools.set(poolId, pool); }
      const state = pool;
      return new Promise((resolve, reject) => {
        const cancel = () => {
          const index = state.waiting.indexOf(waiter);
          if (index >= 0) state.waiting.splice(index, 1);
          signal.removeEventListener("abort", cancel);
          reject(new DOMException("Request cancelled", "AbortError"));
        };
        const waiter: Waiter = { ratio, grant() {
          signal.removeEventListener("abort", cancel);
          state.busy = true;
          let released = false;
          resolve(() => {
            if (released) return;
            released = true;
            state.busy = false;
            const next = state.waiting.shift();
            if (next) next.grant();
            else pools.delete(poolId);
          });
        } };
        if (!state.busy) waiter.grant();
        else {
          state.waiting.push(waiter);
          state.waiting.sort((a, b) => b.ratio - a.ratio);
          signal.addEventListener("abort", cancel, { once: true });
        }
      });
    },
  };
}
export type PoolQueue = ReturnType<typeof createPoolQueue>;
