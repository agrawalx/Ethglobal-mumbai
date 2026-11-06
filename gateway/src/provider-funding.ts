import { keccak256, publicActions, walletActions, type Hex } from "viem";
import { publicArkiv, walletArkiv } from "@gpupool/arkiv";
import type { Config } from "./config.ts";
import type { Db } from "./db.ts";

export type FundingChain = {
  balance(address: Hex): Promise<bigint>;
  prepare(address: Hex, amount: bigint): Promise<Hex>;
  broadcast(raw: Hex): Promise<unknown>;
  receipt(hash: Hex): Promise<"success" | "reverted" | null>;
};
export class ProviderFunding {
  private queue: Promise<unknown> = Promise.resolve();
  private db: Db;
  private chain: FundingChain;
  private amount: bigint;
  constructor(db: Db, chain: FundingChain, amount: bigint) {
    this.db = db; this.chain = chain; this.amount = amount;
    if (amount <= 0n || amount > 10n ** 18n) throw new Error("Provider gas grant must be positive and at most 1 tGLM");
  }
  ensure(memberId: string): Promise<{ enabled: boolean; funded: boolean }> {
    const task = this.queue.then(() => this.fund(memberId));
    this.queue = task.catch(() => {});
    return task;
  }
  private async fund(id: string) {
    const member = this.db.prepare("SELECT node_id, funding_raw, funding_hash, funded_at FROM provider_members WHERE id=? AND approved=1 AND revoked=0")
      .get(id) as { node_id: Hex | null; funding_raw: Hex | null; funding_hash: Hex | null; funded_at: number | null } | undefined;
    if (!member?.node_id) throw new Error("Approved paired node required");
    if (member.funded_at) return { enabled: true, funded: true };
    if (!member.funding_raw) {
      if (await this.chain.balance(member.node_id) >= this.amount) {
        this.db.prepare("UPDATE provider_members SET funded_at=? WHERE id=?").run(Date.now(), id);
        return { enabled: true, funded: true };
      }
      const raw = await this.chain.prepare(member.node_id, this.amount);
      member.funding_raw = raw; member.funding_hash = keccak256(raw);
      // Persist BEFORE broadcast. A lost response/restart must reuse the same signed transaction.
      this.db.prepare("UPDATE provider_members SET funding_raw=?,funding_hash=? WHERE id=?").run(raw, member.funding_hash, id);
    }
    let receipt = await this.chain.receipt(member.funding_hash!);
    if (receipt === "reverted") throw new Error("Provider gas transaction reverted; operator review required");
    if (!receipt) {
      try { await this.chain.broadcast(member.funding_raw); }
      catch (e) { if (!/already known/i.test(String(e))) throw e; }
      receipt = await this.chain.receipt(member.funding_hash!);
    }
    if (receipt === "reverted") throw new Error("Provider gas transaction reverted; operator review required");
    if (receipt === "success") this.db.prepare("UPDATE provider_members SET funded_at=? WHERE id=?").run(Date.now(), id);
    return { enabled: true, funded: receipt === "success" };
  }
}

export function providerFunding(db: Db, cfg: Config): ProviderFunding | null {
  if (!cfg.env.PROVIDER_ARKIV_FUNDER_KEY || cfg.env.PROVIDER_ARKIV_GRANT_WEI === "0") return null;
  const env = { ARKIV_PRIVATE_KEY: cfg.env.PROVIDER_ARKIV_FUNDER_KEY, ARKIV_CHAIN_ID: cfg.env.ARKIV_CHAIN_ID,
    ARKIV_RPC_URL: cfg.env.ARKIV_RPC_URL, ARKIV_ACCESS_KEY: cfg.env.ARKIV_ACCESS_KEY };
  const wallet = walletArkiv(env).extend(walletActions), pub = publicArkiv(env).extend(publicActions);
  const verify = async () => { if (await pub.getChainId() !== 7794095) throw new Error("Provider funding RPC is not Rabdi testnet"); };
  return new ProviderFunding(db, {
    balance: async address => { await verify(); return pub.getBalance({ address }); },
    prepare: async (to, value) => { await verify(); return wallet.signTransaction(await wallet.prepareTransactionRequest({ to, value, account: wallet.account!, chain: wallet.chain! })); },
    broadcast: async raw => { await verify(); return pub.sendRawTransaction({ serializedTransaction: raw }); },
    receipt: async hash => {
      try { return (await pub.getTransactionReceipt({ hash })).status; }
      catch (e) { if (/not found|could not be found/i.test(String(e))) return null; throw e; }
    },
  }, BigInt(cfg.env.PROVIDER_ARKIV_GRANT_WEI));
}
