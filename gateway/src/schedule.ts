import { Client, ContractExecuteTransaction, ContractFunctionParameters, ContractId, PrivateKey, ScheduleCreateTransaction, Timestamp } from "@hiero-ledger/sdk";

/**
 * SPEC §16.4 Scheduled Transactions (HIP-423): `EpochPayoutV2.sweep(epoch)` is permissionless, so the
 * operator account can schedule it for the day the sweep opens, with waitForExpiry, and the network
 * runs it. The gateway keeps no timer and no key for the sweep. Hedera allows scheduling at most about
 * 62 days ahead; a later epoch is scheduled by a later tick.
 */
const MAX_AHEAD_S = 61 * 86_400;

export type SweepScheduler = (epoch: number, atSeconds: number) => Promise<string>;

export function hederaSweepScheduler(opts: { network: string; operatorId: string; operatorKey: string; contractId: string }): { schedule: SweepScheduler; close: () => void } {
  if (opts.network !== "testnet") throw new Error(`HEDERA_NETWORK=${opts.network}: only testnet is allowed (CLAUDE.md §5.7)`);
  const client = Client.forTestnet();
  client.setOperator(opts.operatorId, PrivateKey.fromStringECDSA(opts.operatorKey));
  const contract = ContractId.fromString(opts.contractId);
  return {
    schedule: async (epoch, atSeconds) => {
      const now = Math.floor(Date.now() / 1000);
      if (atSeconds - now > MAX_AHEAD_S) throw new Error(`sweep opens in ${Math.round((atSeconds - now) / 86_400)} days: too far for a scheduled transaction (retried later)`);
      const inner = new ContractExecuteTransaction().setContractId(contract).setGas(300_000)
        .setFunction("sweep", new ContractFunctionParameters().addUint64(epoch));
      const response = await new ScheduleCreateTransaction().setScheduledTransaction(inner)
        .setExpirationTime(Timestamp.fromDate(new Date(Math.max(atSeconds, now + 60) * 1000))).setWaitForExpiry(true)
        .setScheduleMemo(`gpupool sweep ${epoch}`.slice(0, 100)).execute(client);
      const receipt = await response.getReceipt(client);
      if (!receipt.scheduleId) throw new Error(`schedule receipt has no schedule ID (status ${receipt.status.toString()})`);
      return receipt.scheduleId.toString();
    },
    close: () => client.close(),
  };
}

/** Hedera contract ID of an EVM address: PAYOUT_CONTRACT_ID, else the mirror node (`/api/v1/contracts/<evm>`). */
export async function resolveContractId(opts: { contractId?: string; evmAddress: string; mirrorUrl: string }): Promise<string> {
  if (opts.contractId) {
    if (!/^0\.0\.\d+$/.test(opts.contractId)) throw new Error("PAYOUT_CONTRACT_ID must look like 0.0.1234");
    return opts.contractId;
  }
  const r = await fetch(new URL(`/api/v1/contracts/${opts.evmAddress}`, opts.mirrorUrl), { signal: AbortSignal.timeout(15_000) });
  if (!r.ok) throw new Error(`mirror contract lookup returned HTTP ${r.status}`);
  const id = ((await r.json()) as { contract_id?: string }).contract_id;
  if (!id || !/^0\.0\.\d+$/.test(id)) throw new Error("mirror returned no contract_id");
  return id;
}
