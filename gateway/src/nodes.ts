import type { Context } from "hono";
import { verifyMessage, type Hex } from "viem";
import { HeartbeatResponse, NodeHeartbeat, NodeRegisterRequest, NODE_SIGNATURE_HEADER, type NodeRegisterResponse } from "@gpupool/shared";
import type { Config } from "./config.ts";
import type { Db } from "./db.ts";
import { errorResponse } from "./errors.ts";
import { recordHeartbeat } from "./reliability.ts";
import { recordEvent, type Signer } from "./events.ts";

/** shared/README.md "Signatures": the exact string the node key signs at registration. */
export const registerMessage = (nodeId: string, poolId: string, ts: number): string => `gpupool-register:${nodeId}:${poolId}:${ts}`;

const REGISTER_MAX_AGE_MS = 24 * 3600 * 1000;
const HEARTBEAT_SKEW_MS = 60_000;

const issues = (e: { issues: { path: PropertyKey[]; message: string }[] }) =>
  e.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; ");

/**
 * POST /nodes/register (session). Links a node key to the account (SPEC §6.3: max 3 nodes).
 * Re-registering the same node by the same account updates it (idempotent). A node owned by
 * another account → 409. Sets the payout address (required once) → payout_address_set event.
 */
export function registerHandler(db: Db, cfg: Config, signer: Signer) {
  return async (c: Context): Promise<Response> => {
    const accountId = c.get("accountId") as string;
    const parsed = NodeRegisterRequest.safeParse(await c.req.json().catch(() => undefined));
    if (!parsed.success) return errorResponse(c, 400, "bad_request", issues(parsed.error));
    const r = parsed.data;
    const now = Date.now();
    if (r.ts > now + HEARTBEAT_SKEW_MS || now - r.ts > REGISTER_MAX_AGE_MS) return errorResponse(c, 400, "bad_request", "registration link is older than 24 hours (run gpupool-node init again)");
    let sigOk = false;
    try {
      sigOk = await verifyMessage({ address: r.node_id as Hex, message: registerMessage(r.node_id, r.pool_id, r.ts), signature: r.node_sig as Hex });
    } catch {
      sigOk = false;
    }
    if (!sigOk) return errorResponse(c, 401, "unauthorized", "node_sig is not a signature of the node key over gpupool-register:<node_id>:<pool_id>:<ts>");

    const result = db.transaction((): Response | NodeRegisterResponse => {
      const acc = db.prepare("SELECT payout_address FROM accounts WHERE id = ?").get(accountId) as { payout_address: string | null } | undefined;
      if (!acc) return errorResponse(c, 401, "unauthorized", "account not found");
      const owner = db.prepare("SELECT account_id FROM nodes WHERE node_id = ?").get(r.node_id) as { account_id: string } | undefined;
      if (owner && owner.account_id !== accountId) return errorResponse(c, 409, "bad_request", "node is registered to another account");
      if (!owner) {
        const n = (db.prepare("SELECT count(*) AS n FROM nodes WHERE account_id = ?").get(accountId) as { n: number }).n;
        if (n >= cfg.net.max_nodes_per_account) return errorResponse(c, 403, "node_limit_reached", `an account can register at most ${cfg.net.max_nodes_per_account} nodes`);
      }
      if (!acc.payout_address && !r.payout_address) return errorResponse(c, 400, "bad_request", "payout_address is required for the first node (SPEC §10.4)");
      if (owner) {
        db.prepare("UPDATE nodes SET pool_id = ?, gpu = ?, mem_gb = ? WHERE node_id = ?").run(r.pool_id, r.gpu, r.mem_gb, r.node_id);
      } else {
        db.prepare("INSERT INTO nodes (node_id, account_id, pool_id, gpu, mem_gb, registered_at) VALUES (?, ?, ?, ?, ?, ?)").run(r.node_id, accountId, r.pool_id, r.gpu, r.mem_gb, now);
        db.prepare("INSERT INTO node_reliability (node_id, score, updated_at) VALUES (?, ?, ?)").run(r.node_id, cfg.net.reliability.initial_score, now);
      }
      if (r.payout_address && r.payout_address !== acc.payout_address) {
        db.prepare("UPDATE accounts SET payout_address = ? WHERE id = ?").run(r.payout_address, accountId);
        recordEvent(db, signer, { type: "payout_address_set", account_id: accountId as `acc_${string}`, payout_address: r.payout_address }, now);
      }
      return { node_id: r.node_id, account_id: accountId as `acc_${string}`, pool_id: r.pool_id };
    })();
    return result instanceof Response ? result : c.json(result);
  };
}

/**
 * POST /nodes/heartbeat. Header x-gpupool-node-signature = EIP-191 personal_sign by the node key
 * over the RAW body bytes. The body is checked against the signature before it is parsed. ts must
 * be within 60 s. Stores the latest status + layers; records one online observation per heartbeat slot for the rolling uptime score (SPEC §9.1).
 */
export function heartbeatHandler(db: Db, cfg: Config) {
  return async (c: Context): Promise<Response> => {
    const raw = await c.req.text();
    const sig = c.req.header(NODE_SIGNATURE_HEADER);
    if (!sig || !/^0x[0-9a-fA-F]+$/.test(sig)) return errorResponse(c, 401, "unauthorized", `missing ${NODE_SIGNATURE_HEADER}`);
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      return errorResponse(c, 400, "bad_request", "body must be JSON");
    }
    const parsed = NodeHeartbeat.safeParse(json);
    if (!parsed.success) return errorResponse(c, 400, "bad_request", issues(parsed.error));
    const hb = parsed.data;
    let ok = false;
    try {
      ok = await verifyMessage({ address: hb.node_id as Hex, message: { raw: new TextEncoder().encode(raw) }, signature: sig as Hex });
    } catch {
      ok = false;
    }
    if (!ok) return errorResponse(c, 401, "unauthorized", "heartbeat signature does not match node_id");
    const now = Date.now();
    if (Math.abs(now - hb.ts) > HEARTBEAT_SKEW_MS) return errorResponse(c, 400, "bad_request", "heartbeat ts is more than 60 s from gateway time");
    const node = db.prepare("SELECT account_id, pool_id FROM nodes WHERE node_id = ?").get(hb.node_id) as { account_id: string; pool_id: string } | undefined;
    if (!node) return errorResponse(c, 404, "not_found", "node is not registered (open the gpupool-node init link)");
    if (node.pool_id !== hb.pool_id) return errorResponse(c, 400, "bad_request", `node is registered in pool ${node.pool_id}, heartbeat says ${hb.pool_id}`);
    const score = db.transaction(() => {
      db.prepare("UPDATE nodes SET hb_ts = ?, hb_online = ?, hb_model = ?, hb_layers = ?, hb_tok_s = ? WHERE node_id = ?").run(
        now, hb.online ? 1 : 0, hb.model, hb.layers ? JSON.stringify(hb.layers) : null, hb.tok_s, hb.node_id);
      recordHeartbeat(db, cfg, hb.node_id, hb.online, now);
      return (db.prepare("SELECT score FROM node_reliability WHERE node_id = ?").get(hb.node_id) as { score: number } | undefined)?.score;
    })();
    return c.json(HeartbeatResponse.parse({ ok: true, owner_account: node.account_id, reliability: score ?? cfg.net.reliability.initial_score }));
  };
}
