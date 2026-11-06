/* Live PoolApi: the gateway endpoints in spec v0.1 §5.2, plus the Hedera mirror
   node for HCS checks. Reads the backend does not expose yet (404, network down)
   throw, and data/index.ts falls back to the mock for that call with a visible
   badge. Anything with a session or money never falls back. */
import type { Epoch, LedgerEvent, Me, Payout, Receipt } from "@shared/types";
import { env } from "../../config/env";
import { NotImplementedError, PaymentRequired, SessionExpired } from "../api";
import type { ChatChunk, LoginResult, ModelOffer, NetworkSnapshot, PoolApi, WorldRpContext } from "../api";
import { MODELS } from "../mock/fixtures";

const base = () => env.gatewayUrl.replace(/\/$/, ""); // "" → same origin (Vite proxies the gateway paths)
const auth = (token?: string | null): Record<string, string> => (token ? { authorization: `Bearer ${token}` } : {});

/** Pull a readable message out of a gateway error body ({error:{message}} or {error} or {message}). */
async function errorText(res: Response, path: string) {
  try {
    const j = (await res.json()) as { error?: string | { message?: string }; message?: string };
    const m = typeof j.error === "string" ? j.error : (j.error?.message ?? j.message);
    if (m) return m;
  } catch {
    /* not JSON */
  }
  return `${path} → HTTP ${res.status}`;
}

async function call<T>(path: string, init: RequestInit & { what?: string } = {}): Promise<T> {
  const res = await fetch(`${base()}${path}`, { ...init, headers: { accept: "application/json", ...(init.body ? { "content-type": "application/json" } : {}), ...init.headers } });
  if (res.status === 404) throw new NotImplementedError(init.what ?? path);
  if (res.status === 402) throw new PaymentRequired();
  if (res.status === 401) throw new SessionExpired();
  if (res.status >= 500) throw new Error(`HTTP ${res.status} from ${path}`);
  if (!res.ok) throw new Error(await errorText(res, path));
  return (await res.json()) as T;
}
const get = <T,>(path: string, token?: string | null) => call<T>(path, { headers: auth(token) });
const post = <T,>(path: string, body: unknown, token?: string | null, what?: string) =>
  call<T>(path, { method: "POST", body: JSON.stringify(body), headers: auth(token), what });

/** /v1/models is OpenAI-shaped. Metadata (factor, size, layers) comes from gpupool.model; the
    config table in spec §8.1 fills the gaps for the two MVP models. */
function toOffer(entry: Record<string, unknown>): ModelOffer {
  const id = String(entry.id ?? entry.model_id);
  const known = MODELS.find((m) => m.model_id === id);
  return {
    served: entry.served !== false,
    model: {
      model_id: id,
      mlx_variant: (entry.mlx_variant as string | null | undefined) ?? known?.mlx_variant ?? null,
      size_gb: Number(entry.size_gb ?? known?.size_gb ?? 0),
      model_factor: Number(entry.model_factor ?? known?.model_factor ?? 1),
      license: String(entry.license ?? known?.license ?? "—"),
      params_b: Number(entry.params_b ?? known?.params_b ?? 0),
      total_layers: Number(entry.total_layers ?? known?.total_layers ?? 0),
    },
  };
}

export const liveApi: PoolApi = {
  mode: "live",

  auth: {
    rpContext: () => post<WorldRpContext>("/auth/world/rp-signature", { action: env.worldAction }, null, "World login (RP signature)"),
    async verify(result) {
      const r = await post<{ token: string; created?: boolean; me?: Me }>("/auth/world/verify", result, null, "World login");
      return { token: r.token, created: r.created ?? false, me: r.me ?? (await get<Me>("/me", r.token)) } satisfies LoginResult;
    },
  },
  me: (token) => get<Me>("/me", token),
  async registerNode(token, link) {
    await post("/nodes/register", link, token, "node registration");
    return get<Me>("/me", token);
  },

  async models() {
    const r = await get<{ data: Record<string, unknown>[] } | Record<string, unknown>[]>("/v1/models");
    return (Array.isArray(r) ? r : r.data).map(toOffer);
  },

  async *chat(body, token, signal): AsyncIterable<ChatChunk> {
    const t0 = Date.now();
    const res = await fetch(`${base()}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", ...auth(token) },
      body: JSON.stringify({ ...body, stream: true }),
      signal,
    });
    if (res.status === 402) throw new PaymentRequired();
    if (res.status === 401) throw new SessionExpired();
    if (res.status === 503) throw new Error(`No pool is serving ${body.model} right now. You paid nothing.`);
    if (!res.ok || !res.body) throw new Error(await errorText(res, "/v1/chat/completions"));
    const routeHeader = res.headers.get("x-gpupool-route");
    let receiptId: string | undefined = res.headers.get("x-gpupool-request-id") ?? undefined;
    let first = true;
    let tokens = 0;
    const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
    let buf = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += value;
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (data === "[DONE]") {
          yield { delta: "", done: true, receipt_id: receiptId };
          return;
        }
        const j = JSON.parse(data) as { id?: string; choices?: { delta?: { content?: string } }[] };
        receiptId ??= j.id;
        const delta = j.choices?.[0]?.delta?.content ?? "";
        if (first) {
          first = false;
          yield { delta: "", ttft_ms: Date.now() - t0, route: routeHeader ? JSON.parse(routeHeader) : undefined };
        }
        if (delta) {
          tokens++;
          yield { delta, tok_s: +(tokens / Math.max((Date.now() - t0) / 1000, 0.05)).toFixed(1) };
        }
      }
    }
    yield { delta: "", done: true, receipt_id: receiptId };
  },
  request: (id) => get<Receipt>(`/requests/${encodeURIComponent(id)}`),
  async myRequests(token) {
    // No list endpoint in §5.2: find this account's request_settled events, then read each receipt.
    const me = await get<Me>("/me", token);
    const events = await get<LedgerEvent[]>("/ledger/events?type=request_settled&limit=200");
    const ids = events.filter((e) => e.payload.account === me.account_id).slice(0, 10).map((e) => String(e.payload.req_id));
    return Promise.all(ids.map((id) => get<Receipt>(`/requests/${encodeURIComponent(id)}`)));
  },

  async network() {
    const r = await get<Partial<NetworkSnapshot>>("/network");
    return { pools: r.pools ?? [], nodes: r.nodes ?? [], stats: r.stats ?? [], updated_at: r.updated_at ?? Date.now() };
  },
  subscribe(cb) {
    let stopped = false;
    const tick = () =>
      liveApi.network().then(
        (s) => !stopped && cb(s),
        () => undefined,
      );
    void tick();
    const id = setInterval(tick, 5_000);
    return () => {
      stopped = true;
      clearInterval(id);
    };
  },

  ledger(opts) {
    const q = new URLSearchParams();
    if (opts?.type) q.set("type", opts.type);
    if (opts?.limit) q.set("limit", String(opts.limit));
    return get<LedgerEvent[]>(`/ledger/events${q.size ? `?${q}` : ""}`);
  },
  async mirror(topic, seq) {
    const res = await fetch(`${env.mirrorUrl.replace(/\/$/, "")}/api/v1/topics/${encodeURIComponent(topic)}/messages/${seq}`);
    if (res.status === 404) return { found: false };
    if (!res.ok) throw new Error(`Mirror node → HTTP ${res.status}`);
    const j = (await res.json()) as { consensus_timestamp?: string; message?: string };
    let message: string | undefined;
    try {
      message = j.message ? new TextDecoder().decode(Uint8Array.from(atob(j.message), (c) => c.charCodeAt(0))) : undefined;
    } catch {
      message = j.message;
    }
    return { found: true, consensus_ts: j.consensus_timestamp, message };
  },

  payouts: (address) => get<{ epochs: Epoch[]; payouts: Payout[] }>(`/payouts/${encodeURIComponent(address)}`),
  async claim() {
    throw new Error("In live mode the claim is a transaction from your wallet (EpochPayout.claim).");
  },
};
