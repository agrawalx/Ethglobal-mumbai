import { createHash } from "node:crypto";
import type { Context } from "hono";
import { canonicalJson, type ChatCompletionRequest, type ModelConfig, type Route } from "@gpupool/shared";
import type { Completion, OnComplete, Prepare } from "./chat.ts";
import type { Config } from "./config.ts";
import type { Db } from "./db.ts";
import { errorResponse } from "./errors.ts";
import { recordEvent, type Signer } from "./events.ts";
import { availableMc, countRouted, estimateInputTokens, holdMc, releaseHold, settle, tryHold } from "./ledger.ts";
import { currentRoute } from "./route.ts";
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

export type BillingDeps = { cfg: Config; db: Db; signer: Signer; x402: X402 | null; observe?: OnComplete };

function insertRequest(db: Db, cfg: Config, row: { reqId: string; accountId: string | null; payer?: string; tx?: string; amount?: string; model: string; payType: "credits" | "x402"; route: Route | null; promptHash: string; prompt: string }, now: number) {
  db.transaction(() => {
    db.prepare(
      `INSERT INTO requests (req_id, account_id, x402_payer, x402_tx, x402_amount_tinybar, model, pay_type, route, status, prompt_hash, ts)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
    ).run(row.reqId, row.accountId, row.payer ?? null, row.tx ?? null, row.amount ?? null, row.model, row.payType, row.route ? JSON.stringify(row.route) : null, row.promptHash, now);
    db.prepare("INSERT INTO transcripts (req_id, prompt, response, expires_at) VALUES (?, ?, NULL, ?)").run(row.reqId, row.prompt, now + cfg.net.transcript_retention_days * 86_400_000);
  })();
}

/** A failed request costs nothing; the nodes on the route get a reliability penalty unless the client aborted. */
function markFailed(db: Db, reqId: string, route: Route | null, comp: Completion) {
  db.transaction(() => {
    db.prepare("UPDATE requests SET status = 'failed' WHERE req_id = ?").run(reqId);
    if (comp.reason !== "client_aborted") countRouted(db, route, false);
  })();
}

export function makePrepare(d: BillingDeps): Prepare {
  const { cfg, db, signer } = d;
  return async (c: Context, req: ChatCompletionRequest, model: ModelConfig, maxTokens: number, reqId: string) => {
    const accountId = (c.get("accountId") as string | null | undefined) ?? null;
    const now = Date.now();
    const pHash = promptHash(req);
    const prompt = canonicalJson(req.messages);

    if (accountId) {
      const hold = holdMc(cfg.net, model, maxTokens, estimateInputTokens(req.messages));
      if (!tryHold(db, accountId, hold, now)) {
        return errorResponse(c, 403, "insufficient_credits", `this request needs a hold of ${hold} mc; available ${availableMc(db, accountId, now)} mc`);
      }
      const route = currentRoute(db, cfg.net, model, now);
      try {
        insertRequest(db, cfg, { reqId, accountId, model: model.model_id, payType: "credits", route, promptHash: pHash, prompt }, now);
      } catch (e) {
        releaseHold(db, accountId, hold);
        throw e;
      }
      return {
        headers: {},
        finish: (comp) => {
          try {
            if (comp.ok && comp.usage) {
              settle(db, cfg.net, signer, { reqId, accountId, model, hold, inTokens: comp.usage.prompt_tokens, outTokens: comp.usage.completion_tokens, route, promptHash: pHash, respHash: sha256Hex(comp.text) });
              db.prepare("UPDATE transcripts SET response = ? WHERE req_id = ?").run(comp.text, reqId);
              countRouted(db, route, true);
            } else {
              db.transaction(() => {
                releaseHold(db, accountId, hold);
                markFailed(db, reqId, route, comp);
              })();
            }
          } catch (e) {
            // The settle transaction rolled back: give the hold back so credits are not stuck.
            console.error(`billing ${reqId}: settle failed, hold released, request marked failed: ${(e as Error).message}`);
            releaseHold(db, accountId, hold);
            db.prepare("UPDATE requests SET status = 'failed' WHERE req_id = ?").run(reqId);
          }
          d.observe?.(comp);
        },
      };
    }

    if (!d.x402) return errorResponse(c, 402, "payment_required", "no session token, and x402 is not configured on this gateway");
    const paid = await d.x402.charge(c, req, maxTokens);
    if (paid instanceof Response) return paid;
    const route = currentRoute(db, cfg.net, model, now);
    insertRequest(db, cfg, { reqId, accountId: null, payer: paid.payer, tx: paid.tx, amount: paid.amountTinybar, model: model.model_id, payType: "x402", route, promptHash: pHash, prompt }, now);
    console.log(JSON.stringify({ msg: "x402_settled", reqId, payer: paid.payer, tx: paid.tx, amount_tinybar: paid.amountTinybar }));
    return {
      headers: paid.headers,
      finish: (comp) => {
        try {
          if (comp.ok && comp.usage) {
            const respHash = sha256Hex(comp.text);
            db.transaction(() => {
              db.prepare("UPDATE requests SET status = 'ok', in_tokens = ?, out_tokens = ?, resp_hash = ? WHERE req_id = ?").run(comp.usage!.prompt_tokens, comp.usage!.completion_tokens, respHash, reqId);
              db.prepare("UPDATE transcripts SET response = ? WHERE req_id = ?").run(comp.text, reqId);
              countRouted(db, route, true);
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
            markFailed(db, reqId, route, comp);
          }
        } catch (e) {
          console.error(`billing ${reqId}: x402 record failed: ${(e as Error).message}`);
        }
        d.observe?.(comp);
      },
    };
  };
}
