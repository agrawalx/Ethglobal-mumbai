import { Client, PrivateKey, TopicId, TopicMessageSubmitTransaction } from "@hiero-ledger/sdk";
import type { Db } from "./db.ts";

/**
 * HCS writer (SPEC §10.2). Events are first inserted into `ledger_events` with hcs_seq NULL
 * (events.ts, inside the money transaction). This loop submits them in id order, one at a time,
 * so the HCS order matches the SQLite order. It is restart-safe: unsent rows are picked up again.
 * A failed submit stops the tick; the next tick (after a back-off) retries the same row.
 * The user request never waits for this (CLAUDE.md §4.9).
 */

/** Submits one message and returns its topic sequence number. */
export type Submitter = (message: string) => Promise<number>;

export function hederaSubmitter(opts: { network: string; operatorId: string; operatorKey: string; topicId: string }): { submit: Submitter; close: () => void } {
  if (opts.network !== "testnet") throw new Error(`HEDERA_NETWORK=${opts.network}: only testnet is allowed (CLAUDE.md §5.7)`);
  const client = Client.forTestnet();
  // The operator key is ECDSA (secp256k1). fromStringECDSA accepts 0x hex or DER.
  client.setOperator(opts.operatorId, PrivateKey.fromStringECDSA(opts.operatorKey));
  const topic = TopicId.fromString(opts.topicId);
  const submit: Submitter = async (message) => {
    const resp = await new TopicMessageSubmitTransaction().setTopicId(topic).setMessage(message).execute(client);
    const receipt = await resp.getReceipt(client);
    if (receipt.topicSequenceNumber == null) throw new Error(`HCS receipt has no sequence number (status ${receipt.status.toString()})`);
    return Number(receipt.topicSequenceNumber.toString());
  };
  return { submit, close: () => client.close() };
}

type Row = { id: number; type: string; payload: string };

/**
 * Submit every unsent event once, in order. Returns how many were written.
 * On success: ledger_events.hcs_seq is set; for request_settled / x402_payment the matching
 * requests.hcs_seq too (the receipt shows it).
 */
export async function flushOnce(db: Db, submit: Submitter, max = 50): Promise<number> {
  const rows = db.prepare("SELECT id, type, payload FROM ledger_events WHERE hcs_seq IS NULL ORDER BY id LIMIT ?").all(max) as Row[];
  const setEvent = db.prepare("UPDATE ledger_events SET hcs_seq = ? WHERE id = ?");
  const setRequest = db.prepare("UPDATE requests SET hcs_seq = ? WHERE req_id = ?");
  let n = 0;
  for (const r of rows) {
    const seq = await submit(r.payload); // throws → the caller backs off and retries this row
    db.transaction(() => {
      setEvent.run(seq, r.id);
      if (r.type === "request_settled" || r.type === "x402_payment") {
        const reqId = (JSON.parse(r.payload) as { req_id?: string }).req_id;
        if (reqId) setRequest.run(seq, reqId);
      }
    })();
    n++;
  }
  return n;
}

/** Run flushOnce every `intervalMs`; after a failure wait up to 30 s (doubling). Returns stop(). */
export function startHcsWriter(db: Db, submit: Submitter, intervalMs = 1000): () => void {
  let stopped = false;
  let delay = intervalMs;
  let timer: NodeJS.Timeout | undefined;
  const tick = async () => {
    if (stopped) return;
    try {
      const n = await flushOnce(db, submit);
      if (n > 0) console.log(JSON.stringify({ msg: "hcs_written", count: n }));
      delay = intervalMs;
    } catch (e) {
      delay = Math.min(delay * 2, 30_000);
      console.error(`hcs: submit failed, retry in ${delay} ms: ${(e as Error).message}`);
    }
    if (!stopped) timer = setTimeout(tick, delay);
  };
  timer = setTimeout(tick, 0);
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}
