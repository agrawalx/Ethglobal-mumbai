/** Live gateway and mirror access. Errors never substitute fixtures. */
import type { Receipt } from "@shared/types";
import { ModelsResponse, WorldVerifyResponse, NodeRegisterRequest, NodeRegisterResponse } from "@gpupool/shared";
import config from "../../../../shared/config/gpupool.config.json";
import { meFromWire, receiptFromWire, networkFromWire, ledgerFromWire, rpFromWire, payoutsFromWire, keysFromWire, newKeyFromWire, keyRequestsFromWire } from "./adapters";
import { env } from "../../config/env";
import { NotImplementedError, PaymentRequired, SessionExpired } from "../api";
import type { ChatChunk, LoginResult, ModelOffer, PoolApi } from "../api";


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
  const known = config.models.find((m) => m.model_id === id);
  return {
    served: entry.served !== false,
    pools: Number(entry.pools ?? 0),
    model: {
      model_id: id,
      mlx_variant: (entry.mlx_variant as string | null | undefined) ?? known?.mlx_variant ?? null,
      size_gb: Number(entry.size_gb ?? known?.size_gb ?? 0),
      model_factor: Number(entry.model_factor ?? known?.model_factor ?? 1),
      license: String(entry.license ?? known?.license ?? "—"),
      params_b: Number(entry.params_b ?? 0),
      total_layers: Number(entry.total_layers ?? known?.num_layers ?? 0),
    },
  };
}

export const liveApi: PoolApi = {
  mode: "live",

  auth: {
    rpContext: async () => rpFromWire(await post("/auth/world/rp-signature", {}, null, "World login")),
    async verify(result) {
      const r = WorldVerifyResponse.parse(await post("/auth/world/verify", result, null, "World login"));
      return { token:r.token, created:r.new_account, me:await liveApi.me(r.token) } satisfies LoginResult;
    },
  },
  me: async (token) => meFromWire(await get("/me", token)),
  async registerNode(token, link) {
    NodeRegisterResponse.parse(await post("/nodes/register", NodeRegisterRequest.parse(link), token, "node registration"));
    return liveApi.me(token);
  },

  keys: async (token) => keysFromWire(await get("/agents", token)),
  createKey: async (token, name, cap) => newKeyFromWire(await post("/agents", { name, ...(cap === null ? {} : { budget_mc: Math.round(cap * 1000) }) }, token, "API keys")),
  async revokeKey(token, id) {
    await call(`/agents/${encodeURIComponent(id)}`, { method: "DELETE", headers: auth(token), what: "API key" });
  },
  keyRequests: async (token, id) => keyRequestsFromWire(await get(`/agents/${encodeURIComponent(id)}/requests`, token)),

  async models() {
    const r = ModelsResponse.parse(await get("/v1/models"));
    return r.data.map(toOffer);
  },

  async *chat(body, token, signal): AsyncIterable<ChatChunk> {
    const t0 = Date.now();
    const res = await fetch(`${base()}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", ...auth(token), ...(body.pool_id ? { "x-gpupool-pool": body.pool_id } : {}) },
      body: JSON.stringify({ model: body.model, messages: body.messages, max_tokens: body.max_tokens, stream: true }),
      signal,
    });
    if (res.status === 402) throw new PaymentRequired();
    if (res.status === 401) throw new SessionExpired();
    if (res.status === 503) throw new Error(body.pool_id ? `Pool ${body.pool_id} cannot serve ${body.model} right now. You paid nothing.` : `No pool is serving ${body.model} right now. You paid nothing.`);
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
        if ("error" in j) throw new Error(JSON.stringify(j.error));
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
    throw new Error("Inference stream ended without a completion marker");
  },
  request: async (id) => receiptFromWire(await get(`/requests/${encodeURIComponent(id)}`)),
  async myRequests(token) {
    // No list endpoint in §5.2: find this account's request_settled events, then read each receipt.
    const me = await liveApi.me(token);
    const events = await liveApi.ledger({type:"request_settled",limit:100});
    const ids = events.filter((e) => e.payload.account_id === me.account_id).slice(0, 10).map((e) => String(e.payload.req_id));
    return Promise.all(ids.map((id) => liveApi.request(id) as Promise<Receipt>));
  },

  async network() {
    return networkFromWire(await get("/network"));
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

    q.set("limit", String(Math.min(100, opts?.limit ?? 100)));
    return get(`/ledger/events?${q}`).then(ledgerFromWire).then(rows => opts?.type ? rows.filter(r=>r.type===opts.type) : rows);
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

  payouts: async (address) => payoutsFromWire(await get(`/payouts/${encodeURIComponent(address)}`)),
  async claim() {
    throw new Error("In live mode the claim is a transaction from your wallet (EpochPayout.claim).");
  },
};
