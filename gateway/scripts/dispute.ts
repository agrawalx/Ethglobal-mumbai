/**
 * Owner CLI for EpochPayoutV2 disputes (SPEC §16.4). Preview by default; --broadcast sends testnet transactions.
 *   resolve: node scripts/dispute.ts --epoch N --exclude 0xaddr[,0xaddr] --evidence ver_01… [--broadcast]
 *   dismiss: node scripts/dispute.ts --epoch N --dismiss [--broadcast]
 * Env (ignored file): OWNER_PRIVATE_KEY, PAYOUT_CONTRACT_ADDRESS, HEDERA_JSON_RPC_URL, DATABASE_PATH, GATEWAY_SIGNING_KEY.
 */
import { parseArgs } from "node:util";
import { createPublicClient, createWalletClient, http, type Hex } from "viem";
import { hederaTestnet } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";
import { openDb } from "../src/db.ts";
import { signerFromSeed } from "../src/events.ts";
import { PAYOUT_ABI_V2, privateKey } from "../src/payout-chain.ts";
import { applyResolution, evidenceHash, planResolution } from "../src/dispute.ts";

const { values } = parseArgs({ options: {
  broadcast: { type: "boolean", default: false }, dismiss: { type: "boolean", default: false },
  epoch: { type: "string" }, exclude: { type: "string", default: "" }, evidence: { type: "string" },
} });
const e = process.env;
if ((e.HEDERA_NETWORK ?? "testnet") !== "testnet" || Number(e.HEDERA_CHAIN_ID ?? 296) !== 296) throw new Error("disputes require Hedera testnet");
for (const key of ["OWNER_PRIVATE_KEY", "PAYOUT_CONTRACT_ADDRESS", "HEDERA_JSON_RPC_URL", "DATABASE_PATH", "GATEWAY_SIGNING_KEY"]) if (!e[key]) throw new Error(`missing ${key}`);
if (e.PAYOUT_CONTRACT_VERSION !== "2") throw new Error("disputes need PAYOUT_CONTRACT_VERSION=2 (EpochPayoutV2)");
if (!values.epoch || !/^\d+$/.test(values.epoch)) throw new Error("--epoch N is required");
const epoch = Number(values.epoch);
const account = privateKeyToAccount(privateKey(e.OWNER_PRIVATE_KEY!));
const transport = http(e.HEDERA_JSON_RPC_URL!);
const pub = createPublicClient({ chain: hederaTestnet, transport });
if (await pub.getChainId() !== 296) throw new Error("dispute RPC is not Hedera testnet");
const wallet = createWalletClient({ chain: hederaTestnet, transport, account });
const address = e.PAYOUT_CONTRACT_ADDRESS as Hex;
if ((await pub.readContract({ address, abi: [{ type: "function", name: "owner", inputs: [], outputs: [{ type: "address" }], stateMutability: "view" }], functionName: "owner" })).toLowerCase() !== account.address.toLowerCase()) throw new Error("OWNER_PRIVATE_KEY is not the contract owner");

if (values.dismiss) {
  const sim = await pub.simulateContract({ address, abi: PAYOUT_ABI_V2, functionName: "dismiss", args: [BigInt(epoch)], account });
  console.log(JSON.stringify({ action: "dismiss", epoch, broadcast: values.broadcast }));
  if (values.broadcast) {
    const tx = await wallet.writeContract(sim.request);
    if ((await pub.waitForTransactionReceipt({ hash: tx, timeout: 60_000 })).status !== "success") throw new Error(`dismiss reverted: ${tx}`);
    console.log(`Dismissed: https://hashscan.io/testnet/transaction/${tx}`);
  }
} else {
  if (!values.evidence) throw new Error("--evidence <verification id> is required");
  const exclude = values.exclude.split(",").map((s) => s.trim()).filter(Boolean);
  if (!exclude.length) throw new Error("--exclude <payout addresses> is required (use dismiss to reject a challenge)");
  const db = openDb(e.DATABASE_PATH!, { resetOnMismatch: false });
  const plan = planResolution(db, epoch, exclude);
  console.log(JSON.stringify({ action: "resolve", epoch, excluded: plan.excluded, oldTotal: plan.oldTotal.toString(), newTotal: plan.newTotal.toString(), refundedToTreasury: plan.refunded.toString(), newRoot: plan.newRoot, broadcast: values.broadcast }));
  const sim = await pub.simulateContract({ address, abi: PAYOUT_ABI_V2, functionName: "resolve", args: [BigInt(epoch), plan.newRoot, plan.newTotal, evidenceHash(values.evidence)], account });
  if (values.broadcast) {
    const tx = await wallet.writeContract(sim.request);
    if ((await pub.waitForTransactionReceipt({ hash: tx, timeout: 60_000 })).status !== "success") throw new Error(`resolve reverted: ${tx}`);
    applyResolution(db, signerFromSeed(e.GATEWAY_SIGNING_KEY!), plan, values.evidence);
    console.log(`Resolved and stored: https://hashscan.io/testnet/transaction/${tx}`);
  }
  db.close();
}
