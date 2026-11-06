import { canonicalJson, MerkleLeaf, PayoutRoute, type PayoutsResponse } from "@gpupool/shared";
import type { Hex } from "viem";
import type { Config } from "./config.ts";
import type { Db } from "./db.ts";
import { recordEvent, signEvent, type Signer, type UnsignedEvent } from "./events.ts";
import { payoutTree, ZERO_ROOT } from "./merkle.ts";
import { validLayerMap } from "./route.ts";

export type EpochState = {
  root: Hex; total: bigint; claimed: bigint; postedAt: bigint;
  /** V2: first second at which claims can be made (challenge window and vesting over). */
  opensAt?: bigint;
  /** V2: first second at which the unclaimed value can be swept to the treasury. */
  sweepAt?: bigint;
  state?: "open" | "challenged" | "voided";
};
/** V2 dispute events of one epoch, in block order. */
export type Dispute = { type: "challenged"; evidence: Hex } | { type: "dismissed" } | { type: "resolved"; newRoot: Hex; newTotal: bigint };
/** SPEC §16.4: where the epoch bundle goes (Swarm). Returns the reference. */
export type BundleStore = { upload(name: string, json: string): Promise<string> };
export type SignedTx = { raw: Hex; hash: Hex };
export type Claim = { type: "claim"; address: Hex; amount: bigint; tx: Hex } | { type: "sweep"; tx: Hex };
export type SettlementChain = {
  needsFunding: boolean;
  verify(): Promise<void>;
  resolvePayer(account: string): Promise<Hex>;
  epoch(epoch: number): Promise<EpochState>;
  prepareFunding(amount: bigint): Promise<SignedTx>;
  /** V2 also takes the HCS sequence of the epoch_closed message and the vesting unlock time (unix seconds, 0 = none). */
  preparePost(epoch: number, root: Hex, amount: bigint, hcsSeq?: number, unlockAt?: number): Promise<SignedTx>;
  broadcast(raw: Hex): Promise<Hex>;
  receipt(hash: Hex): Promise<{ status: "success" | "reverted"; blockNumber: bigint } | null>;
  claimDelay(): Promise<bigint>;
  blockNumber(): Promise<bigint>;
  claims(epoch: number, from: bigint, to: bigint): Promise<Claim[]>;
  /** V2 only. */
  disputes?(epoch: number, from: bigint, to: bigint): Promise<Dispute[]>;
  /** V2 only: schedule `sweep(epoch)` at `atSeconds` as a Hedera scheduled transaction; returns the schedule ID. */
  scheduleSweep?(epoch: number, atSeconds: number): Promise<string>;
};
export type PaidRequest = { req_id: string; model: string; status: string; x402_payer: string | null; x402_tx: string | null; x402_amount_tinybar: string | null; payout_snapshot: string | null };

/** BigInt only: 80% providers, per-request layer floors; missing/self shares and dust stay in treasury. */
export function providerPayouts(cfg: Config, requests: PaidRequest[], payerAddresses: Map<string, Hex>): MerkleLeaf[] {
  const amounts = new Map<string, bigint>();
  for (const r of requests) {
    if (r.status !== "ok" || !r.payout_snapshot) continue;
    const snapshot = PayoutRoute.parse(JSON.parse(r.payout_snapshot));
    const model = cfg.model(r.model);
    if (!model || !validLayerMap(snapshot, model.num_layers)) throw new Error(`invalid payout layer map for ${r.req_id}`);
    if (!r.x402_amount_tinybar || !/^\d+$/.test(r.x402_amount_tinybar)) throw new Error(`missing x402 amount for ${r.req_id}`);
    const payer = r.x402_payer ? payerAddresses.get(r.x402_payer) : undefined;
    if (!payer) throw new Error(`payer identity unresolved for ${r.req_id}`);
    const share = BigInt(r.x402_amount_tinybar) * BigInt(cfg.net.x402_split_bps.providers) / 10_000n;
    for (const hop of snapshot) {
      const address = hop.payout_address;
      if (!address || /^0x0{40}$/.test(address) || address === payer) continue;
      const amount = share * BigInt(hop.layers[1] - hop.layers[0]) / BigInt(model.num_layers);
      amounts.set(address, (amounts.get(address) ?? 0n) + amount);
    }
  }
  return [...amounts].filter(([, n]) => n > 0n).map(([payout_address, n]) => ({ payout_address, amount_tinybar: n.toString() }));
}

type EpochRow = { epoch: number; total_tinybar: string; merkle_root: Hex; status: string; hcs_event_id: number; funding_raw: Hex | null; funding_tx: Hex | null; post_raw: Hex | null; post_tx: Hex | null; posted_block: string | null; claims_block: string | null; sweep_schedule: string | null; swarm_ref: string | null };

/** Everything a third party needs to rebuild an epoch's Merkle root and audit its income (no transcripts, no prompts). */
export function epochBundle(db: Db, signerPublicKey: string, epoch: number, start: number, end: number, tree: { root: Hex; hash: Hex; payouts: MerkleLeaf[] }, total: string) {
  const receipts = (db.prepare(`SELECT req_id, model, status, x402_payer, x402_tx, x402_amount_tinybar, in_tokens, out_tokens, payout_snapshot, prompt_hash, resp_hash, route_source, ts
    FROM requests WHERE pay_type = 'x402' AND ts >= ? AND ts < ? ORDER BY ts, req_id`).all(start, end) as (Record<string, unknown> & { payout_snapshot: string | null })[])
    .map((r) => ({ ...r, payout_snapshot: r.payout_snapshot ? JSON.parse(r.payout_snapshot) : null }));
  return { version: 1, gateway_pubkey: signerPublicKey, epoch, start_ts: start, end_ts: end, total_tinybar: total,
    merkle_root: tree.root, payouts_hash: tree.hash, payouts: tree.payouts, receipts };
}

/** Closed epoch snapshots and signed raw transactions survive restart. One worker owns these wallets. */
export function createSettlement(db: Db, cfg: Config, signer: Signer, chain: SettlementChain, store?: BundleStore) {
  const duration = (cfg.env.EPOCH_SECONDS ?? 600) * 1000;
  // SPEC §16.4 multiple gateways: epoch ids live in this gateway's namespace on the contract.
  const base = cfg.env.GATEWAY_INDEX * 2 ** 32;
  let running = false;

  async function closeDue(now: number) {
    const boundary = Math.floor(now / duration) * duration;
    const due = db.prepare(`SELECT DISTINCT CAST(ts / ? AS INTEGER) AS epoch FROM requests
      WHERE pay_type = 'x402' AND ts < ? ORDER BY epoch`).all(duration, boundary) as { epoch: number }[];
    const payers = new Map<string, Hex>();
    for (const { epoch: n } of due) {
      const epoch = base + n;
      if (db.prepare("SELECT 1 FROM epochs WHERE epoch = ?").get(epoch)) continue;
      const start = n * duration;
      const rows = db.prepare(`SELECT * FROM requests WHERE pay_type = 'x402' AND ts >= ? AND ts < ? ORDER BY ts, req_id`).all(start, start + duration) as PaidRequest[];
      if (rows.some((r) => r.status === "pending")) continue;
      // An on-chain payment can fund providers once, even if a payment header is replayed.
      const unique = rows.filter((r) => r.x402_tx && (db.prepare(`SELECT req_id FROM requests WHERE pay_type = 'x402' AND x402_tx = ? ORDER BY ts, req_id LIMIT 1`).get(r.x402_tx) as { req_id: string }).req_id === r.req_id);
      for (const r of unique) {
        if (r.status === "ok" && r.payout_snapshot && r.x402_payer && !payers.has(r.x402_payer)) payers.set(r.x402_payer, await chain.resolvePayer(r.x402_payer));
      }
      const tree = payoutTree(epoch, providerPayouts(cfg, unique, payers));
      const total = tree.payouts.reduce((sum, p) => sum + BigInt(p.amount_tinybar), 0n).toString();
      // SPEC §16.4 Swarm: the bundle goes out first, so every closed epoch has a reference. A Bee outage
      // delays the close (retried next tick); it never closes an epoch without its bundle.
      let swarmRef: string | undefined;
      if (store) {
        try {
          swarmRef = await store.upload(`epoch-${epoch}.json`, canonicalJson(epochBundle(db, signer.publicKeyHex, epoch, start, start + duration, tree, total)));
        } catch (e) {
          console.error(`epoch ${epoch}: Swarm upload failed, close retried: ${(e as Error).message}`);
          continue;
        }
      }
      let event: UnsignedEvent = { type: "epoch_closed", epoch, start_ts: start, end_ts: start + duration,
        total_tinybar: total, merkle_root: tree.root, payouts_hash: tree.hash, payouts: tree.payouts, ...(swarmRef ? { swarm_ref: swarmRef } : {}) };
      if (Buffer.byteLength(canonicalJson(signEvent(signer, event, now))) >= 1024) event = { ...event, payouts: null };
      db.transaction(() => {
        recordEvent(db, signer, event, now);
        const id = (db.prepare("SELECT last_insert_rowid() AS id").get() as { id: number }).id;
        db.prepare(`INSERT INTO epochs (epoch, start_ts, end_ts, total_tinybar, merkle_root, status, hcs_event_id, swarm_ref)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(epoch, start, start + duration, total, tree.root, tree.payouts.length ? "closed" : "empty", id, swarmRef ?? null);
        for (const p of tree.proofs) db.prepare(`INSERT INTO epoch_payouts (epoch, payout_address, amount_tinybar, proof)
          VALUES (?, ?, ?, ?)`).run(epoch, p.payout_address, p.amount_tinybar, JSON.stringify(p.proof));
      })();
    }
  }

  async function confirm(raw: Hex, hash: Hex) {
    let receipt = await chain.receipt(hash);
    if (!receipt) {
      try {
        const sent = await chain.broadcast(raw);
        if (sent !== hash) throw new Error("broadcast returned a different transaction hash");
      } catch (error) {
        receipt = await chain.receipt(hash);
        if (!receipt) throw error;
      }
      receipt ??= await chain.receipt(hash);
    }
    if (receipt?.status === "reverted") throw new Error(`settlement transaction reverted: ${hash}`);
    return receipt;
  }

  async function postDue() {
    const rows = db.prepare("SELECT * FROM epochs WHERE status IN ('closed', 'funding', 'funded', 'posting') ORDER BY epoch").all() as EpochRow[];
    for (const r of rows) {
      const hcs = db.prepare("SELECT hcs_seq FROM ledger_events WHERE id = ?").get(r.hcs_event_id) as { hcs_seq: number | null };
      if (hcs.hcs_seq === null) return; // audit commitment must reach HCS before any funding/post
      const total = BigInt(r.total_tinybar);
      const onchain = await chain.epoch(r.epoch);
      if (onchain.root !== ZERO_ROOT && (onchain.root !== r.merkle_root || onchain.total !== total)) throw new Error(`epoch ${r.epoch} conflicts with the contract`);
      if (onchain.root === ZERO_ROOT) {
        if (chain.needsFunding) {
          if (!r.funding_raw) {
            const tx = await chain.prepareFunding(total);
            r.funding_raw = tx.raw; r.funding_tx = tx.hash;
            db.prepare("UPDATE epochs SET funding_raw = ?, funding_tx = ?, status = 'funding' WHERE epoch = ?").run(tx.raw, tx.hash, r.epoch);
          }
          if (!(await confirm(r.funding_raw, r.funding_tx!))) return;
        }
        db.prepare("UPDATE epochs SET status = 'funded' WHERE epoch = ?").run(r.epoch);
        if (!r.post_raw) {
          // V2: link the post to its signed HCS message; vesting unlock is fixed when the transaction is signed.
          const unlockAt = cfg.env.PAYOUT_VESTING_SECONDS > 0 ? Math.floor(Date.now() / 1000) + cfg.env.PAYOUT_VESTING_SECONDS : 0;
          const tx = await chain.preparePost(r.epoch, r.merkle_root, total, hcs.hcs_seq, unlockAt);
          r.post_raw = tx.raw; r.post_tx = tx.hash;
          db.prepare("UPDATE epochs SET post_raw = ?, post_tx = ?, status = 'posting' WHERE epoch = ?").run(tx.raw, tx.hash, r.epoch);
        }
      }
      if (!r.post_raw || !r.post_tx) throw new Error(`epoch ${r.epoch} was posted outside this worker; review before reconciliation`);
      const receipt = await confirm(r.post_raw, r.post_tx);
      if (!receipt) return;
      const state = await chain.epoch(r.epoch);
      if (state.root !== r.merkle_root || state.total !== total) throw new Error(`posted epoch ${r.epoch} did not match local payouts`);
      const claimable = state.opensAt !== undefined ? Number(state.opensAt) * 1000 : Number(state.postedAt + await chain.claimDelay()) * 1000;
      db.prepare("UPDATE epochs SET status = 'posted', posted_block = ?, claims_block = ?, claimable_at = ? WHERE epoch = ?")
        .run(receipt.blockNumber.toString(), (receipt.blockNumber - 1n).toString(), claimable, r.epoch);
    }
  }

  async function syncClaims() {
    const epochs = db.prepare("SELECT * FROM epochs WHERE status IN ('posted', 'challenged') ORDER BY epoch").all() as EpochRow[];
    if (!epochs.length) return;
    const latest = await chain.blockNumber();
    for (const e of epochs) {
      const from = BigInt(e.claims_block!) + 1n;
      if (from > latest) continue;
      const to = from + 1999n < latest ? from + 1999n : latest;
      const claims = await chain.claims(e.epoch, from, to);
      const disputes = chain.disputes ? await chain.disputes(e.epoch, from, to) : [];
      db.transaction(() => {
        // SPEC §16.4 disputes: a challenged epoch exposes no proofs until it is resolved or dismissed.
        for (const d of disputes) {
          if (d.type === "challenged") db.prepare("UPDATE epochs SET status = 'challenged' WHERE epoch = ?").run(e.epoch);
          else if (d.type === "dismissed") db.prepare("UPDATE epochs SET status = 'posted' WHERE epoch = ?").run(e.epoch);
          else {
            const local = db.prepare("SELECT merkle_root, status FROM epochs WHERE epoch = ?").get(e.epoch) as { merkle_root: Hex; status: string };
            // `scripts/dispute.ts` already stored the corrected payouts; any other resolution needs a person.
            if (d.newRoot === local.merkle_root || (d.newRoot === ZERO_ROOT && local.merkle_root === ZERO_ROOT)) db.prepare("UPDATE epochs SET status = 'posted' WHERE epoch = ?").run(e.epoch);
            else {
              db.prepare("UPDATE epochs SET status = 'review' WHERE epoch = ?").run(e.epoch);
              console.error(`epoch ${e.epoch}: resolved on-chain to ${d.newRoot}, local payouts differ; use scripts/dispute.ts --record`);
            }
          }
        }
        for (const c of claims) {
          if (c.type === "sweep") {
            db.prepare("UPDATE epochs SET status = 'swept' WHERE epoch = ?").run(e.epoch);
            continue;
          }
          const row = db.prepare("SELECT amount_tinybar, claimed FROM epoch_payouts WHERE epoch = ? AND payout_address = ?").get(e.epoch, c.address) as { amount_tinybar: string; claimed: number } | undefined;
          if (!row || BigInt(row.amount_tinybar) !== c.amount) throw new Error(`unexpected claim in epoch ${e.epoch}`);
          if (row.claimed) continue;
          db.prepare("UPDATE epoch_payouts SET claimed = 1, claim_tx = ? WHERE epoch = ? AND payout_address = ?").run(c.tx, e.epoch, c.address);
          recordEvent(db, signer, { type: "payout_claimed", epoch: e.epoch, payout_address: c.address, amount_tinybar: c.amount.toString(), claim_tx: c.tx });
        }
        db.prepare("UPDATE epochs SET claims_block = ? WHERE epoch = ?").run(to.toString(), e.epoch);
      })();

    }
  }

  /** SPEC §16.4: sweep each posted epoch with a Hedera scheduled transaction (no gateway key, no gateway timer). */
  async function scheduleSweeps() {
    if (!chain.scheduleSweep || cfg.env.SCHEDULE_SWEEP !== "true") return;
    const rows = db.prepare("SELECT epoch FROM epochs WHERE status IN ('posted', 'challenged') AND sweep_schedule IS NULL ORDER BY epoch").all() as { epoch: number }[];
    for (const { epoch } of rows) {
      const state = await chain.epoch(epoch);
      if (state.sweepAt === undefined) continue;
      try {
        const id = await chain.scheduleSweep(epoch, Number(state.sweepAt));
        db.prepare("UPDATE epochs SET sweep_schedule = ? WHERE epoch = ?").run(id, epoch);
      } catch (e) {
        console.error(`epoch ${epoch}: scheduling the sweep failed (retried): ${(e as Error).message}`);
      }
    }
  }

  return {
    closeDue,
    async runOnce(now = Date.now()) {
      if (running) return;
      running = true;
      try { await chain.verify(); await closeDue(now); await postDue(); await syncClaims(); await scheduleSweeps(); }
      finally { running = false; }
    },
  };
}

/** Only contract-confirmed epochs are exposed. Funding/HCS delays never produce a claimable proof. */
export function payoutsFor(db: Db, address: string, now = Date.now()): PayoutsResponse {
  const rows = db.prepare(`SELECT p.*, e.merkle_root, e.post_tx, e.claimable_at, e.status FROM epoch_payouts p
    JOIN epochs e ON e.epoch = p.epoch WHERE p.payout_address = ? AND e.status IN ('posted', 'swept') ORDER BY p.epoch DESC`).all(address) as {
    epoch: number; amount_tinybar: string; merkle_root: Hex; proof: string; claimed: number; claim_tx: Hex | null; post_tx: Hex; claimable_at: number; status: string;
  }[];
  return { payout_address: address, payouts: rows.map((r) => ({ epoch: r.epoch, amount_tinybar: r.amount_tinybar,
    merkle_root: r.merkle_root, proof: JSON.parse(r.proof), claimed: !!r.claimed, claim_tx: r.claim_tx, post_tx: r.post_tx,
    claimable_at: r.claimable_at, claimable: !r.claimed && r.status === 'posted' && now >= r.claimable_at, swept: r.status === 'swept' })) };
}

export function startSettlementWorker(settlement: ReturnType<typeof createSettlement>, intervalMs = 10_000): () => void {
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  const tick = async () => {
    if (stopped) return;
    try { await settlement.runOnce(); }
    catch (e) { console.error(`epoch settlement failed: ${(e as Error).message}`); }
    if (!stopped) timer = setTimeout(tick, intervalMs);
  };
  timer = setTimeout(tick, 0);
  return () => { stopped = true; if (timer) clearTimeout(timer); };
}
