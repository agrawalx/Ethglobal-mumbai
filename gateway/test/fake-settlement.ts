import { keccak256, toHex, type Hex } from "viem";
import { ZERO_ROOT } from "../src/merkle.ts";
import type { Claim, EpochState, SettlementChain, SignedTx } from "../src/settlement.ts";
const PAYER = `0x${"c1".repeat(20)}` as Hex;

export class FakeChain implements SettlementChain {
  needsFunding = true;
  states = new Map<number, EpochState>();
  txs = new Map<Hex, { kind: "fund" | "post"; amount: bigint; epoch?: number; root?: Hex }>();
  receipts = new Map<Hex, { status: "success" | "reverted"; blockNumber: bigint }>();
  events: { epoch: number; block: bigint; event: Claim }[] = [];
  block = 10n;
  postedAt = 1200n;
  funds = 0;
  posts = 0;
  prepares = 0;
  failReceiptAfterFunding = false;
  holdReceipts = false;
  verify = async () => {};
  resolvePayer = async () => PAYER;
  epoch = async (e: number) => this.states.get(e) ?? { root: ZERO_ROOT, total: 0n, claimed: 0n, postedAt: 0n };
  make(kind: "fund" | "post", amount: bigint, epoch?: number, root?: Hex): SignedTx {
    const raw = toHex(++this.prepares);
    const hash = keccak256(raw);
    this.txs.set(hash, { kind, amount, epoch, root });
    return { raw, hash };
  }
  prepareFunding = async (amount: bigint) => this.make("fund", amount);
  preparePost = async (epoch: number, root: Hex, amount: bigint) => this.make("post", amount, epoch, root);
  broadcast = async (raw: Hex) => {
    const hash = keccak256(raw);
    if (this.receipts.has(hash) || this.holdReceipts) return hash;
    const tx = this.txs.get(hash)!;
    if (tx.kind === "fund") this.funds++;
    else {
      this.posts++;
      this.states.set(tx.epoch!, { root: tx.root!, total: tx.amount, claimed: 0n, postedAt: this.postedAt });
    }
    this.receipts.set(hash, { status: "success", blockNumber: ++this.block });
    return hash;
  };
  receipt = async (hash: Hex) => {
    if (this.failReceiptAfterFunding && this.funds) { this.failReceiptAfterFunding = false; throw new Error("RPC unavailable after transfer"); }
    return this.receipts.get(hash) ?? null;
  };
  claimDelay = async () => 60n;
  blockNumber = async () => this.block;
  claims = async (epoch: number, from: bigint, to: bigint) => this.events.filter((e) => e.epoch === epoch && e.block >= from && e.block <= to).map((e) => e.event);
}
