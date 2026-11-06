import { randomBytes } from "node:crypto";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { ModelsResponse, PoolId, Receipt, REQUEST_ID_HEADER, RequestId } from "@gpupool/shared";
import type { Config } from "./config.ts";
import type { Db } from "./db.ts";
import { chatHandler, logCompletion, type OnComplete } from "./chat.ts";
import { errorResponse } from "./errors.ts";
import type { Signer } from "./events.ts";
import { session } from "./auth.ts";
import { makePrepare } from "./billing.ts";
import { me } from "./accounts.ts";
import { heartbeatHandler, registerHandler } from "./nodes.ts";
import { poolState } from "./route.ts";
import { rpSignatureHandler, verifyHandler, type WorldFetch } from "./world.ts";
import type { X402 } from "./x402.ts";

export type Deps = {
  cfg: Config;
  db: Db;
  signer: Signer;
  /** null = x402 not configured: requests without a session get 402 payment_required. */
  x402?: X402 | null;
  worldFetch?: WorldFetch;
  /** Observer, runs after billing for every completion. */
  onComplete?: OnComplete;
};

export const newReqId = (): string => `req_${Date.now().toString(36)}${randomBytes(8).toString("hex")}`;

export type AppEnv = { Variables: { reqId: string; accountId: string | null } };

type RequestRow = {
  req_id: string; model: string; pay_type: "credits" | "x402"; status: "pending" | "ok" | "failed"; account_id: string | null;
  x402_payer: string | null; x402_tx: string | null; x402_amount_tinybar: string | null; in_tokens: number | null; out_tokens: number | null;
  cost_mc: number | null; split: string | null; route: string | null; prompt_hash: string; resp_hash: string | null; hcs_seq: number | null; ts: number;
};

export function createApp({ cfg, db, signer, x402 = null, worldFetch, onComplete = logCompletion }: Deps): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  const secret = cfg.env.JWT_SECRET;

  if (cfg.corsOrigins.length > 0) {
    app.use("*", cors({ origin: cfg.corsOrigins, exposeHeaders: [REQUEST_ID_HEADER, "PAYMENT-REQUIRED", "PAYMENT-RESPONSE"] }));
  }

  // Every /v1/chat/completions response carries the request id, errors included.
  app.use("/v1/chat/completions", async (c, next) => {
    const reqId = newReqId();
    c.set("reqId", reqId);
    await next();
    c.res.headers.set(REQUEST_ID_HEADER, reqId);
  });

  app.get("/healthz", (c) => c.json({ ok: true as const }));

  // Session if an Authorization header is present (invalid → 401), else x402 (SPEC §5.3 step 2).
  app.post("/v1/chat/completions", session(secret, false), chatHandler(cfg, makePrepare({ cfg, db, signer, x402, observe: onComplete })));

  app.post("/auth/world/rp-signature", rpSignatureHandler(cfg));
  app.post("/auth/world/verify", verifyHandler(db, cfg, signer, worldFetch));

  app.get("/me", session(secret, true), (c) => {
    const body = me(db, cfg, c.get("accountId")!);
    return body ? c.json(body) : errorResponse(c, 404, "not_found", "account not found");
  });

  app.post("/nodes/register", session(secret, true), registerHandler(db, cfg, signer));
  app.post("/nodes/heartbeat", heartbeatHandler(db, cfg));

  app.get("/pools/:pool_id", (c) => {
    const id = PoolId.safeParse(c.req.param("pool_id"));
    if (!id.success) return errorResponse(c, 400, "bad_request", "bad pool_id");
    return c.json(poolState(db, cfg.net, id.data));
  });

  app.get("/requests/:id", (c) => {
    const id = RequestId.safeParse(c.req.param("id"));
    if (!id.success) return errorResponse(c, 400, "bad_request", "bad request id");
    const r = db.prepare("SELECT * FROM requests WHERE req_id = ?").get(id.data) as RequestRow | undefined;
    if (!r) return errorResponse(c, 404, "not_found", `no request ${id.data}`);
    const receipt = {
      ...r,
      split: r.split ? JSON.parse(r.split) : null,
      route: r.route ? JSON.parse(r.route) : null,
    };
    return c.json(Receipt.parse(receipt));
  });

  // TEMP (until step 3.1): the model list comes from the pool's GET /v1/models, filtered to
  // config models, with pools = 1. Step 3.1 replaces this with ready gpupool.pool entities from
  // Arkiv (that is why `source` is "arkiv" in the shared schema). Pool down → empty list.
  app.get("/v1/models", async (c) => {
    let live: string[] = [];
    try {
      const r = await fetch(new URL("/v1/models", cfg.env.POOL_COORDINATOR_URL), { signal: AbortSignal.timeout(3000) });
      if (r.ok) {
        const body = (await r.json()) as { data?: { id?: unknown }[] };
        live = (body.data ?? []).map((m) => String(m.id));
      } else {
        console.warn(`pool /v1/models returned HTTP ${r.status}`);
      }
    } catch (e) {
      console.warn(`pool /v1/models unreachable: ${(e as Error).message}`);
    }
    const res: ModelsResponse = {
      object: "list",
      data: cfg.net.models
        .filter((m) => live.includes(m.model_id))
        .map((m) => ({ id: m.model_id, object: "model", created: 0, owned_by: "gpupool", model_factor: m.model_factor, pools: 1, source: "arkiv" })),
    };
    return c.json(ModelsResponse.parse(res));
  });

  app.notFound((c) => errorResponse(c, 404, "not_found", `no route ${c.req.method} ${c.req.path}`));
  app.onError((e, c) => {
    console.error(e);
    return errorResponse(c, 500, "internal", "internal error");
  });
  return app;
}
