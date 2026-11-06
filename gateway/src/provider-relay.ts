import { randomBytes } from "node:crypto";
import type { ProviderJob } from "@gpupool/shared";
import type { z } from "zod";

type Job = { wire: z.infer<typeof ProviderJob>; pool: string; delivered: boolean; resolve: (response: Response) => void;
  reject: (error: Error) => void; cleanup: () => void; accepted: boolean; cancelStream?: () => void };
type Poll = { resolve: (job: z.infer<typeof ProviderJob> | null) => void; cleanup: () => void };

/** Outbound-only coordinator connection. All payment/auth/settlement stays in chat.ts. */
export class ProviderRelay {
  private jobs = new Map<string, Job>();
  private polls = new Map<string, Poll>();

  forward(pool: string, path: "/v1/chat/completions" | "/cluster/status_json", body: unknown, signal?: AbortSignal): Promise<Response> {
    if (signal?.aborted) return Promise.reject(new Error("request cancelled"));
    if ([...this.jobs.values()].filter(j => j.pool === pool).length >= 8) return Promise.reject(new Error("provider relay is busy"));
    return new Promise((resolve, reject) => {
      const id = randomBytes(16).toString("hex");
      const cancel = () => { this.jobs.delete(id); clearTimeout(timer); signal?.removeEventListener("abort", abort); };
      const abort = () => { this.jobs.get(id)?.cancelStream?.(); cancel(); reject(new Error("provider relay cancelled")); };
      const timer = setTimeout(() => { this.jobs.get(id)?.cancelStream?.(); cancel(); reject(new Error("provider relay timed out")); }, 600_000);
      timer.unref();
      const job: Job = { wire: { id, path, body: body ?? null }, pool, delivered: false, accepted: false,
        resolve, reject, cleanup: cancel };
      this.jobs.set(id, job);
      signal?.addEventListener("abort", abort, { once: true });
      const poll = this.polls.get(pool);
      if (poll) { poll.cleanup(); job.delivered = true; poll.resolve(job.wire); }
    });
  }

  poll(pool: string, signal?: AbortSignal): Promise<z.infer<typeof ProviderJob> | null> {
    const queued = [...this.jobs.values()].find(j => j.pool === pool && !j.delivered);
    if (queued) { queued.delivered = true; return Promise.resolve(queued.wire); }
    const previous = this.polls.get(pool);
    if (previous) { previous.cleanup(); previous.resolve(null); }
    return new Promise(resolve => {
      const cleanup = () => { clearTimeout(timer); signal?.removeEventListener("abort", abort); this.polls.delete(pool); };
      const abort = () => { cleanup(); resolve(null); };
      const timer = setTimeout(abort, 20_000);
      timer.unref();
      this.polls.set(pool, { resolve, cleanup });
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort();
    });
  }

  async accept(pool: string, id: string, status: number, contentType: string, body: ReadableStream<Uint8Array>): Promise<void> {
    const job = this.jobs.get(id);
    if (!job || job.pool !== pool || !job.delivered || job.accepted) throw new Error("unknown or completed relay job");
    job.accepted = true;
    const reader = body.getReader();
    let bytes = 0;
    let finish!: () => void;
    const done = new Promise<void>(resolve => { finish = resolve; });
    const close = () => { job.cleanup(); finish(); };
    const stream = new ReadableStream<Uint8Array>({
      start(controller) { job.cancelStream = () => { controller.error(new Error("Provider relay disconnected")); void reader.cancel().catch(() => {}); close(); }; },
      async pull(controller) {
        try {
          const next = await reader.read();
          if (next.done) { controller.close(); close(); return; }
          bytes += next.value.byteLength;
          if (bytes > 16 * 1024 * 1024) throw new Error("provider response exceeds limit");
          controller.enqueue(next.value);
        } catch (error) { controller.error(error); void reader.cancel().catch(() => {}); close(); }
      },
      cancel() { void reader.cancel().catch(() => {}); close(); },
    });
    job.resolve(new Response(stream, { status, headers: { "content-type": contentType } }));
    await done;
  }

  closePool(pool: string) {
    for (const job of this.jobs.values()) if (job.pool === pool) { job.cancelStream?.(); job.cleanup(); job.reject(new Error("provider disconnected")); }
    const poll = this.polls.get(pool);
    if (poll) { poll.cleanup(); poll.resolve(null); }
  }
}
