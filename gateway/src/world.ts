import type { Context } from "hono";
import { signRequest } from "@worldcoin/idkit-core/signing";
import { RpSignatureResponse, WorldVerifyRequest, type WorldVerifyResponse } from "@gpupool/shared";
import { loginOrCreate } from "./accounts.ts";
import { issueToken } from "./auth.ts";
import type { Config } from "./config.ts";
import type { Db } from "./db.ts";
import { errorResponse } from "./errors.ts";
import type { Signer } from "./events.ts";

/**
 * World ID login, IDKit v4 (SPEC §6). Findings and doc links: gateway/README.md "World ID".
 * - rp-signature: `signRequest` from @worldcoin/idkit-core/signing (the RP signing key stays here).
 * - verify: forward the IDKit result unchanged to POST WORLD_VERIFY_URL/{rp_id} (no auth header).
 *   200 + success:true → nullifier (0x hex). The portal accepts a REUSED nullifier with 200
 *   ("nullifier reuse"), so our UNIQUE world_nullifier is the only one-account-per-human guard.
 * - accepted credentials (SPEC §6.1): Orb (`proof_of_human`, legacy v3 `orb`) or Selfie Check
 *   (`selfie`, legacy alias `face`).
 */

export const ACCEPTED_CREDENTIALS = new Set(["proof_of_human", "orb", "selfie", "face"]);
export const WORLD_VERIFY_URL = "https://developer.world.org/api/v4/verify";

/** fetch for the World API, injected so tests can mock the World API. */
export type WorldFetch = (url: string, init: RequestInit) => Promise<Response>;

const worldEnv = (cfg: Config) => {
  const e = cfg.env;
  const missing = ["WORLD_APP_ID", "WORLD_RP_ID", "WORLD_RP_SIGNING_KEY", "WORLD_ACTION", "JWT_SECRET", "GATEWAY_SIGNING_KEY"].filter((k) => !e[k as keyof typeof e]);
  if (missing.length) throw new Error(`World login needs ${missing.join(", ")} (gateway/.env)`);
  return { appId: e.WORLD_APP_ID!, rpId: e.WORLD_RP_ID!, key: e.WORLD_RP_SIGNING_KEY!, action: e.WORLD_ACTION!, environment: (e.WORLD_ENVIRONMENT ?? "staging") as "staging" | "production" };
};

export function rpSignatureHandler(cfg: Config) {
  return (c: Context): Response => {
    let w;
    try {
      w = worldEnv(cfg);
    } catch (e) {
      return errorResponse(c, 500, "internal", (e as Error).message);
    }
    const r = signRequest({ signingKeyHex: w.key, action: w.action });
    return c.json(RpSignatureResponse.parse({ sig: r.sig, nonce: r.nonce, created_at: r.createdAt, expires_at: r.expiresAt, rp_id: w.rpId, app_id: w.appId, action: w.action, environment: w.environment }));
  };
}

type VerifyOk = { success: true; nullifier?: string; action?: string; environment?: string; message?: string; results?: { identifier?: string; success?: boolean }[] };

/** World error body: {code, detail} or {success:false, code, detail, results}. */
const worldError = (body: any): string => [body?.code, body?.detail].filter(Boolean).join(": ") || "unknown error";

export function verifyHandler(db: Db, cfg: Config, signer: Signer, worldFetch: WorldFetch = fetch) {
  return async (c: Context): Promise<Response> => {
    let w;
    try {
      w = worldEnv(cfg);
    } catch (e) {
      return errorResponse(c, 500, "internal", (e as Error).message);
    }
    const parsed = WorldVerifyRequest.safeParse(await c.req.json().catch(() => undefined));
    if (!parsed.success) return errorResponse(c, 400, "bad_request", "body must be the IDKit result object");
    const result = parsed.data;
    // Docs: check action and environment before forwarding.
    if (result.action !== undefined && result.action !== w.action) return errorResponse(c, 400, "bad_request", `proof is for action ${String(result.action)}, expected ${w.action}`);
    if (result.environment !== undefined && result.environment !== w.environment) return errorResponse(c, 400, "bad_request", `proof environment ${String(result.environment)}, expected ${w.environment}`);

    const url = `${WORLD_VERIFY_URL}/${w.rpId}`;
    let res: Response;
    try {
      res = await worldFetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(result), signal: AbortSignal.timeout(15_000) });
    } catch (e) {
      return errorResponse(c, 502, "internal", `World verify API unreachable: ${(e as Error).message}`);
    }
    const body = (await res.json().catch(() => null)) as any;
    if (!res.ok || body?.success !== true) return errorResponse(c, 401, "unauthorized", `World rejected the proof (HTTP ${res.status}): ${worldError(body)}`);
    const ok = body as VerifyOk;
    const nullifier = typeof ok.nullifier === "string" ? ok.nullifier.toLowerCase() : "";
    if (!/^0x[0-9a-f]{1,64}$/.test(nullifier)) return errorResponse(c, 502, "internal", "World verify response has no nullifier");
    if (ok.environment !== undefined && ok.environment !== w.environment) return errorResponse(c, 401, "unauthorized", `World verified in ${ok.environment}, expected ${w.environment}`);
    const used = (ok.results ?? []).filter((r) => r.success !== false).map((r) => r.identifier ?? "");
    if (!used.some((id) => ACCEPTED_CREDENTIALS.has(id))) return errorResponse(c, 401, "unauthorized", `credential ${used.join(",") || "unknown"} is not accepted (Orb or Selfie Check only)`);

    // Normalise to 32-byte 0x hex so the same human always maps to the same row.
    const key = `0x${nullifier.slice(2).padStart(64, "0")}`;
    const login = loginOrCreate(db, cfg, signer, key);
    const token = await issueToken(cfg.env.JWT_SECRET!, login.accountId, cfg.net.session_ttl_s);
    const out: WorldVerifyResponse = { token, account_id: login.accountId as WorldVerifyResponse["account_id"], new_account: login.newAccount, starter_granted_mc: login.starterGrantedMc };
    return c.json(out);
  };
}
