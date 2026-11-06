/** Provider CLI (frontend-independent). Preview by default; --broadcast spends testnet gas. */
import { parseArgs } from "node:util";
import { createPublicClient, createWalletClient, http, type Hex } from "viem";
import { hederaTestnet } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";
import { PayoutsResponse } from "@gpupool/shared";
import { PAYOUT_ABI, privateKey } from "../src/payout-chain.ts";
import { verifyPayoutProof } from "../src/merkle.ts";

const { values } = parseArgs({ options: { broadcast: { type: "boolean", default: false }, epoch: { type: "string" } } });
const e = process.env;
if ((e.HEDERA_NETWORK ?? "testnet") !== "testnet" || Number(e.HEDERA_CHAIN_ID ?? 296) !== 296) throw new Error("claims require Hedera testnet");
for (const key of ["GATEWAY_URL", "PROVIDER_PRIVATE_KEY", "PAYOUT_CONTRACT_ADDRESS", "HEDERA_JSON_RPC_URL"]) if (!e[key]) throw new Error(`missing ${key}`);
const account = privateKeyToAccount(privateKey(e.PROVIDER_PRIVATE_KEY!));
const address = account.address.toLowerCase() as Hex;
const pub = createPublicClient({ chain: hederaTestnet, transport: http(e.HEDERA_JSON_RPC_URL!) });
if (await pub.getChainId() !== 296) throw new Error("claim RPC is not Hedera testnet");
const response = await fetch(new URL(`/payouts/${address}`, e.GATEWAY_URL!), { signal: AbortSignal.timeout(15_000) });
if (!response.ok) throw new Error(`payout API returned HTTP ${response.status}`);
const data = PayoutsResponse.parse(await response.json());
if (data.payout_address !== address) throw new Error("payout API returned a different provider address");
const contract = e.PAYOUT_CONTRACT_ADDRESS! as Hex;
const wallet = createWalletClient({ chain: hederaTestnet, transport: http(e.HEDERA_JSON_RPC_URL!), account });
let count = 0;
for (const p of data.payouts) {
  if (values.epoch && String(p.epoch) !== values.epoch) continue;
  if (p.claimed || p.swept || !p.claimable) continue;
  if (!verifyPayoutProof(address, BigInt(p.amount_tinybar), p.proof as Hex[], p.merkle_root as Hex)) throw new Error(`invalid Merkle proof for epoch ${p.epoch}`);
  const args = [BigInt(p.epoch), BigInt(p.amount_tinybar), p.proof as Hex[]] as const;
  // Simulation checks root, claim delay, prior claims and available contract funds on chain.
  const simulation = await pub.simulateContract({ address: contract, abi: PAYOUT_ABI, functionName: "claim", args, account });
  console.log(JSON.stringify({ epoch: p.epoch, provider: address, amount_tinybar: p.amount_tinybar, broadcast: values.broadcast }));
  if (values.broadcast) {
    const tx = await wallet.writeContract(simulation.request);
    const receipt = await pub.waitForTransactionReceipt({ hash: tx, timeout: 60_000 });
    if (receipt.status !== "success") throw new Error(`claim reverted: ${tx}`);
    console.log(`Claim confirmed: https://hashscan.io/testnet/transaction/${tx}`);
  }
  count++;
}
console.log(`${count} ${values.broadcast ? "claims confirmed" : "claims previewed; add --broadcast to submit"}`);
