import { randomBytes } from "node:crypto";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { EvmAddress, LedgerEventsResponse, ModelsResponse, NetworkResponse, PayoutsResponse, PoolId, Receipt, REQUEST_ID_HEADER, RequestId } from "@gpupool/shared";
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
import { payoutsFor } from "./settlement.ts";
import { createPoolQueue } from "./queue.ts";
import { arkivDirectory, createRouter, type Directory } from "./router.ts";

export type Deps = {
  cfg: Config;
  db: Db;
  signer: Signer;
  /** null = x402 not configured: requests without a session get 402 payment_required. */
  x402?: X402 | null;
  worldFetch?: WorldFetch;
  directory?: Directory;
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

export function createApp({ cfg, db, signer, x402 = null, worldFetch, directory, onComplete = logCompletion }: Deps): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  const secret = cfg.env.JWT_SECRET;
  const router = createRouter(cfg, db, directory ?? arkivDirectory(cfg));
  const queue = createPoolQueue();

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
  app.post("/v1/chat/completions", session(secret, false), chatHandler(cfg, makePrepare({ cfg, db, signer, x402, router, queue, observe: onComplete })));

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

  app.get("/network", async (c) => {
    try { return c.json(NetworkResponse.parse(await router.network())); }
    catch (e) {
      console.warn(`arkiv network read failed: ${(e as Error).name}`);
      c.header("Retry-After", String(cfg.net.router.retry_after_s));
      return errorResponse(c, 503, "no_pool_available", "Arkiv directory unavailable");
    }
  });

  app.get("/ledger/events", (c) => {
    const limits = c.req.queries("limit") ?? [];
    const raw = limits[0] ?? "50";
    if (limits.length > 1 || !/^[1-9][0-9]*$/.test(raw) || Number(raw) > 100) return errorResponse(c, 400, "bad_request", "limit must be an integer from 1 to 100");
    const rows = db.prepare("SELECT id, payload, hcs_seq FROM ledger_events ORDER BY id DESC LIMIT ?").all(Number(raw)) as { id: number; payload: string; hcs_seq: number | null }[];
    return c.json(LedgerEventsResponse.parse({ events: rows.map((r) => ({ id: r.id, event: JSON.parse(r.payload), hcs_seq: r.hcs_seq })) }));
  });

  app.get("/payouts/:address", (c) => {
    const address = EvmAddress.safeParse(c.req.param("address").toLowerCase());
    if (!address.success) return errorResponse(c, 400, "bad_request", "invalid payout address");
    return c.json(PayoutsResponse.parse(payoutsFor(db, address.data)));
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

  app.get("/v1/models", async (c) => {
    try {
      return c.json(ModelsResponse.parse(await router.models()));
    } catch (e) {
      console.warn(`arkiv discovery failed: ${(e as Error).name}`);
      c.header("Retry-After", String(cfg.net.router.retry_after_s));
      return errorResponse(c, 503, "no_pool_available", "Arkiv directory unavailable");
    }
  });

  app.notFound((c) => errorResponse(c, 404, "not_found", `no route ${c.req.method} ${c.req.path}`));
  app.onError((e, c) => {
    console.error(e);
    return errorResponse(c, 500, "internal", "internal error");
  });
  return app;
}
