import { createHash } from "node:crypto";
import type { Context } from "hono";
import { canonicalJson, type ChatCompletionRequest, type ModelConfig, type PayoutRoute, type Route } from "@gpupool/shared";
import type { Completion, OnComplete, Prepare } from "./chat.ts";
import type { Config } from "./config.ts";
import type { Db } from "./db.ts";
import { errorResponse } from "./errors.ts";
import { recordEvent, type Signer } from "./events.ts";
import { availableMc, estimateInputTokens, holdMc, releaseHold, settle, tryHold } from "./ledger.ts";
import { contributionRatio } from "./accounts.ts";
import { countRouted } from "./reliability.ts";
import type { PoolQueue } from "./queue.ts";
import type { Router, SelectedPool } from "./router.ts";
import type { X402 } from "./x402.ts";

/**
 * Billing for /v1/chat/completions (SPEC §5.3, §7):
 *  - session → hold credits, settle from `usage` at the end, split to the route's node owners;
 *  - no session → x402: settle the HBAR payment before serving.
 * Hashes (shared/README.md): sha256, 0x hex. prompt_hash = sha256(canonical JSON of `messages`),
 * resp_hash = sha256(UTF-8 response text).
 */

export const sha256Hex = (s: string): string => `0x${createHash("sha256").update(s, "utf8").digest("hex")}`;
export const promptHash = (req: ChatCompletionRequest): string => sha256Hex(canonicalJson(req.messages));

export type BillingDeps = { cfg: Config; db: Db; signer: Signer; x402: X402 | null; router: Router; queue: PoolQueue; observe?: OnComplete };

function insertRequest(db: Db, cfg: Config, row: { reqId: string; accountId: string | null; payer?: string; tx?: string; amount?: string; model: string; payType: "credits" | "x402"; route: Route | null; promptHash: string; prompt: string }, now: number) {
  db.transaction(() => {
    db.prepare(
      `INSERT INTO requests (req_id, account_id, x402_payer, x402_tx, x402_amount_tinybar, model, pay_type, route, status, prompt_hash, ts)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
    ).run(row.reqId, row.accountId, row.payer ?? null, row.tx ?? null, row.amount ?? null, row.model, row.payType, row.route ? JSON.stringify(row.route) : null, row.promptHash, now);
    if (row.payType === "x402") {
      const snapshot: PayoutRoute | null = row.route?.map((hop) => {
        const owner = db.prepare(`SELECT n.account_id, a.payout_address FROM nodes n
          JOIN accounts a ON a.id = n.account_id WHERE n.node_id = ?`).get(hop.node_id) as { account_id: `acc_${string}`; payout_address: `0x${string}` | null };
        return { ...hop, owner_account: owner.account_id, payout_address: owner.payout_address };
      }) ?? null;
      db.prepare("UPDATE requests SET payout_snapshot = ? WHERE req_id = ?").run(snapshot ? JSON.stringify(snapshot) : null, row.reqId);
    }
    db.prepare("INSERT INTO transcripts (req_id, prompt, response, expires_at) VALUES (?, ?, NULL, ?)").run(row.reqId, row.prompt, now + cfg.net.transcript_retention_days * 86_400_000);
  })();
}

/** A failed request costs nothing; the nodes on the route get a reliability penalty unless the client aborted. */
function markFailed(db: Db, cfg: Config, reqId: string, route: Route | null, comp: Completion) {
  db.transaction(() => {
    db.prepare("UPDATE requests SET status = 'failed' WHERE req_id = ?").run(reqId);
    if (comp.reason !== "client_aborted") countRouted(db, cfg, route, false);
  })();
}

export function makePrepare(d: BillingDeps): Prepare {
  const { cfg, db, signer } = d;
  return async (c: Context, req: ChatCompletionRequest, model: ModelConfig, maxTokens: number, reqId: string) => {
    const accountId = (c.get("accountId") as string | null | undefined) ?? null;
    let now = Date.now();
    const pHash = promptHash(req);
    const prompt = canonicalJson(req.messages);

    if (!accountId && !d.x402) return errorResponse(c, 402, "payment_required", "no session token, and x402 is not configured on this gateway");
    let selected: SelectedPool | null;
    try {
      selected = await d.router.select(model);
    } catch (e) {
      console.warn(`arkiv routing failed: ${(e as Error).name}`);
      c.header("Retry-After", String(cfg.net.router.retry_after_s));
      return errorResponse(c, 503, "no_pool_available", "Arkiv directory unavailable");
    }
    if (!selected) {
      c.header("Retry-After", String(cfg.net.router.retry_after_s));
      return errorResponse(c, 503, "no_pool_available", `no ready pool for ${model.model_id}`);
    }
    const ratioRow = accountId ? db.prepare("SELECT earned_total_mc, spent_total_mc FROM balances WHERE account_id = ?").get(accountId) as { earned_total_mc: number; spent_total_mc: number } | undefined : undefined;
    const ratio = accountId ? contributionRatio(ratioRow?.earned_total_mc ?? 0, ratioRow?.spent_total_mc ?? 0) : 1;
    let releaseQueue: () => void;
    try {
      releaseQueue = await d.queue.acquire(selected.poolId, ratio, c.req.raw.signal);
    } catch (e) {
      if ((e as Error).name !== "AbortError") throw e;
      return errorResponse(c, 408, "bad_request", "request cancelled while waiting");
    }
    let prepared = false;
    try {
      // Recheck the chosen pool after waiting: listings and signed layer ranges can change.
      try {
        selected = await d.router.select(model, selected.poolId);
      } catch (e) {
        console.warn(`arkiv admission failed: ${(e as Error).name}`);
        c.header("Retry-After", String(cfg.net.router.retry_after_s));
        return errorResponse(c, 503, "no_pool_available", "Arkiv directory unavailable");
      }
      if (!selected) {
        c.header("Retry-After", String(cfg.net.router.retry_after_s));
        return errorResponse(c, 503, "no_pool_available", `pool no longer ready for ${model.model_id}`);
      }
      if (c.req.raw.signal.aborted) return errorResponse(c, 408, "bad_request", "request cancelled while waiting");
      now = Date.now();
      const poolId = selected.poolId;
      const route = selected.route;
      const coordinatorUrl = selected.coordinatorUrl;
      const trackedFinish = (finish: OnComplete): OnComplete => {
        const release = d.router.start(poolId);
        prepared = true;
        let finished = false;
        return (comp) => {
          if (finished) return;
          finished = true;
          try { finish(comp); } finally { release(); releaseQueue(); }
        };
      };

      if (accountId) {
        const hold = holdMc(cfg.net, model, maxTokens, estimateInputTokens(req.messages));
        if (!tryHold(db, accountId, hold, now)) {
          return errorResponse(c, 403, "insufficient_credits", `this request needs a hold of ${hold} mc; available ${availableMc(db, accountId, now)} mc`);
        }
        try {
          insertRequest(db, cfg, { reqId, accountId, model: model.model_id, payType: "credits", route, promptHash: pHash, prompt }, now);
        } catch (e) {
          releaseHold(db, accountId, hold);
          throw e;
        }
        return {
          headers: {},
          coordinatorUrl,
          finish: trackedFinish((comp) => {
            try {
              if (comp.ok && comp.usage) {
                // Commit billing, the transcript and its reliability outcome together. A later
                // database failure must not leave a charged request marked as failed.
                db.transaction(() => {
                  settle(db, cfg.net, signer, { reqId, accountId, model, hold, inTokens: comp.usage!.prompt_tokens, outTokens: comp.usage!.completion_tokens, route, promptHash: pHash, respHash: sha256Hex(comp.text) });
                  db.prepare("UPDATE transcripts SET response = ? WHERE req_id = ?").run(comp.text, reqId);
                  countRouted(db, cfg, route, true);
                })();
              } else {
                db.transaction(() => {
                  releaseHold(db, accountId, hold);
                  markFailed(db, cfg, reqId, route, comp);
                })();
              }
            } catch (e) {
              // The settle transaction rolled back: give the hold back so credits are not stuck.
              console.error(`billing ${reqId}: settle failed, hold released, request marked failed: ${(e as Error).message}`);
              releaseHold(db, accountId, hold);
              db.prepare("UPDATE requests SET status = 'failed' WHERE req_id = ?").run(reqId);
            }
            d.observe?.(comp);
          }),
        };
      }

      if (!d.x402) return errorResponse(c, 402, "payment_required", "no session token, and x402 is not configured on this gateway");
      const paid = await d.x402.charge(c, req, maxTokens);
      if (paid instanceof Response) return paid;
      insertRequest(db, cfg, { reqId, accountId: null, payer: paid.payer, tx: paid.tx, amount: paid.amountTinybar, model: model.model_id, payType: "x402", route, promptHash: pHash, prompt }, Date.now());
      console.log(JSON.stringify({ msg: "x402_settled", reqId, payer: paid.payer, tx: paid.tx, amount_tinybar: paid.amountTinybar }));
      return {
        headers: paid.headers,
        coordinatorUrl,
        finish: trackedFinish((comp) => {
          try {
            if (comp.ok && comp.usage) {
              const respHash = sha256Hex(comp.text);
              db.transaction(() => {
                db.prepare("UPDATE requests SET status = 'ok', in_tokens = ?, out_tokens = ?, resp_hash = ? WHERE req_id = ?").run(comp.usage!.prompt_tokens, comp.usage!.completion_tokens, respHash, reqId);
                db.prepare("UPDATE transcripts SET response = ? WHERE req_id = ?").run(comp.text, reqId);
                countRouted(db, cfg, route, true);
                recordEvent(db, signer, {
                  type: "x402_payment",
                  req_id: reqId as `req_${string}`,
                  payer: paid.payer,
                  tx_id: paid.tx,
                  amount_tinybar: paid.amountTinybar,
                  model: model.model_id,
                  in_tokens: comp.usage!.prompt_tokens,
                  out_tokens: comp.usage!.completion_tokens,
                  route,
                  pay: "x402",
                  prompt_hash: pHash as `0x${string}`,
                  resp_hash: respHash as `0x${string}`,
                });
              })();
            } else {
              // Paid but not served: the payment stays in the treasury (refunds are out of scope).
              console.warn(`x402 ${reqId}: paid (${paid.tx}) but the pool failed (${comp.reason}); recorded as failed, no refund`);
              markFailed(db, cfg, reqId, route, comp);
            }
          } catch (e) {
            console.error(`billing ${reqId}: x402 record failed: ${(e as Error).message}`);
          }
          d.observe?.(comp);
        }),
      };
    } finally {
      if (!prepared) releaseQueue();
    }
  };
}
