import { createPublicClient, createWalletClient, encodeFunctionData, getAddress, http, keccak256, parseAbi, TransactionReceiptNotFoundError, type Hex } from "viem";
import { hederaTestnet } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";
import { EvmAddress } from "@gpupool/shared";
import type { Config } from "./config.ts";
import type { Claim, SettlementChain, SignedTx } from "./settlement.ts";

export const PAYOUT_ABI = parseAbi([
  "function settler() view returns (address)",
  "function claimDelay() view returns (uint64)",
  "function epochs(uint64) view returns (bytes32 root, uint256 total, uint256 claimed, uint64 postedAt)",
  "function hasClaimed(uint64,address) view returns (bool)",
  "function postEpoch(uint64,bytes32) payable",
  "function claim(uint64,uint256,bytes32[])",
  "event Claimed(uint64 indexed epoch,address indexed account,uint256 amount)",
  "event Swept(uint64 indexed epoch,uint256 amount)",
]);

export const tinybarsToWeibars = (amount: bigint): bigint => {
  if (amount < 0n) throw new Error("negative HBAR amount");
  return amount * 10_000_000_000n;
};

export function privateKey(raw: string): Hex {
  const hex = raw.startsWith("0x") ? raw : `0x${raw}`;
  if (!/^0x[0-9a-fA-F]{64}$/.test(hex)) throw new Error("payout signing key must be 32-byte ECDSA hex");
  return hex as Hex;
}

/** No network or signing until the worker runs. Wallets are reserved for this one settlement worker. */
export function hederaSettlementChain(cfg: Config): SettlementChain {
  const e = cfg.env;
  if ((e.HEDERA_NETWORK ?? "testnet") !== "testnet" || Number(e.HEDERA_CHAIN_ID ?? 296) !== 296) throw new Error("payouts require Hedera testnet (chain 296)");
  if (!e.HEDERA_JSON_RPC_URL || !e.PAYOUT_CONTRACT_ADDRESS || !e.SETTLER_PRIVATE_KEY || !e.TREASURY_PRIVATE_KEY) throw new Error("payouts need HEDERA_JSON_RPC_URL, PAYOUT_CONTRACT_ADDRESS, SETTLER_PRIVATE_KEY and TREASURY_PRIVATE_KEY");
  const address = getAddress(e.PAYOUT_CONTRACT_ADDRESS);
  const settler = privateKeyToAccount(privateKey(e.SETTLER_PRIVATE_KEY));
  const treasury = privateKeyToAccount(privateKey(e.TREASURY_PRIVATE_KEY));
  const transport = http(e.HEDERA_JSON_RPC_URL, { timeout: 15_000, retryCount: 0 });
  const pub = createPublicClient({ chain: hederaTestnet, transport });
  const wallet = (account: typeof settler) => createWalletClient({ chain: hederaTestnet, transport, account });
  const sign = async (account: typeof settler, to: Hex, amount: bigint, data?: Hex): Promise<SignedTx> => {
    const client = wallet(account);
    const request = await client.prepareTransactionRequest({ to, value: tinybarsToWeibars(amount), data, type: "legacy" });
    const raw = await client.signTransaction(request);
    return { raw, hash: keccak256(raw) };
  };
  return {
    needsFunding: settler.address !== treasury.address,
    async verify() {
      if (await pub.getChainId() !== 296) throw new Error("payout RPC is not Hedera testnet");
      const actual = await pub.readContract({ address, abi: PAYOUT_ABI, functionName: "settler" });
      if (actual.toLowerCase() !== settler.address.toLowerCase()) throw new Error("SETTLER_PRIVATE_KEY does not match EpochPayout.settler");
      // Resolve and match the configured treasury ID as well as the receiving x402 account.
      if (!e.TREASURY_ACCOUNT_ID || e.X402_PAY_TO !== e.TREASURY_ACCOUNT_ID) throw new Error("X402_PAY_TO must match TREASURY_ACCOUNT_ID for payouts");
      if (await this.resolvePayer(e.TREASURY_ACCOUNT_ID) !== treasury.address.toLowerCase()) throw new Error("TREASURY_PRIVATE_KEY does not match TREASURY_ACCOUNT_ID");
    },
    async resolvePayer(id) {
      if (!/^0\.0\.\d+$/.test(id)) throw new Error("invalid Hedera payer account ID");
      const base = e.HEDERA_MIRROR_URL ?? "https://testnet.mirrornode.hedera.com";
      const response = await fetch(new URL(`/api/v1/accounts/${id}`, base), { signal: AbortSignal.timeout(15_000) });
      if (!response.ok) throw new Error(`mirror account lookup returned HTTP ${response.status}`);
      const body = await response.json() as { evm_address?: string };
      return EvmAddress.parse(body.evm_address?.toLowerCase()) as Hex;
    },
    async epoch(epoch) {
      const [root, total, claimed, postedAt] = await pub.readContract({ address, abi: PAYOUT_ABI, functionName: "epochs", args: [BigInt(epoch)] });
      return { root, total, claimed, postedAt };
    },
    prepareFunding: (amount) => sign(treasury, settler.address, amount),
    preparePost: (epoch, root, amount) => sign(settler, address, amount, encodeFunctionData({ abi: PAYOUT_ABI, functionName: "postEpoch", args: [BigInt(epoch), root] })),
    broadcast: (raw) => pub.sendRawTransaction({ serializedTransaction: raw }),
    async receipt(hash) {
      try {
        const r = await pub.getTransactionReceipt({ hash });
        return { status: r.status, blockNumber: r.blockNumber };
      } catch (e) {
        if (e instanceof TransactionReceiptNotFoundError) return null;
        throw e;
      }
    },
    claimDelay: () => pub.readContract({ address, abi: PAYOUT_ABI, functionName: "claimDelay" }),
    blockNumber: () => pub.getBlockNumber({ cacheTime: 0 }),
    async claims(epoch, fromBlock, toBlock) {
      const [claimed, swept] = await Promise.all([
        pub.getContractEvents({ address, abi: PAYOUT_ABI, eventName: "Claimed", args: { epoch: BigInt(epoch) }, fromBlock, toBlock, strict: true }),
        pub.getContractEvents({ address, abi: PAYOUT_ABI, eventName: "Swept", args: { epoch: BigInt(epoch) }, fromBlock, toBlock, strict: true }),
      ]);
      return [
        ...claimed.map((c): Claim => ({ type: "claim", address: c.args.account.toLowerCase() as Hex, amount: c.args.amount, tx: c.transactionHash })),
        ...swept.map((c): Claim => ({ type: "sweep", tx: c.transactionHash })),
      ];
    },
  };
}
