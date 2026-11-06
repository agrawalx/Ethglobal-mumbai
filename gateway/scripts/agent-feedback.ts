/** Actual x402 payer posts receipt-linked ERC-8004 feedback. Simulates unless --broadcast. */
import { parseArgs } from "node:util";
import { canonicalJson, Receipt } from "@gpupool/shared";
import { createPublicClient, createWalletClient, getAddress, http, keccak256, toBytes } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { hederaTestnet } from "viem/chains";
import { privateKey } from "../src/payout-chain.ts";
import { REPUTATION_ABI } from "../src/erc8004.ts";

const { values } = parseArgs({ options: { request: { type: "string" }, score: { type: "string", default: "100" }, broadcast: { type: "boolean", default: false } } });
const e = process.env;
const score = Number(values.score);
if (!Number.isInteger(score) || score < 0 || score > 100) throw new Error("score must be an integer 0–100");
if (!e.GATEWAY_URL || !e.ERC8004_REPUTATION_REGISTRY || !e.ERC8004_AGENT_ID || !e.PROVIDER_PRIVATE_KEY || !values.request) throw new Error("set GATEWAY_URL, ERC8004_REPUTATION_REGISTRY, ERC8004_AGENT_ID, PROVIDER_PRIVATE_KEY (payer's key), and --request req_id");
const account = privateKeyToAccount(privateKey(e.PROVIDER_PRIVATE_KEY));
const uri = new URL(`/requests/${encodeURIComponent(values.request)}`, e.GATEWAY_URL).toString();
const response = await fetch(uri, { signal: AbortSignal.timeout(10_000) });
if (!response.ok) throw new Error(`receipt HTTP ${response.status}`);
const receipt = Receipt.parse(await response.json());
if (receipt.pay_type !== "x402" || receipt.status !== "ok" || !receipt.x402_tx || !receipt.x402_payer) throw new Error("feedback requires a successfully served x402 receipt");
const mirror = await fetch(new URL(`/api/v1/accounts/${receipt.x402_payer}`, e.HEDERA_MIRROR_URL ?? "https://testnet.mirrornode.hedera.com"), { signal: AbortSignal.timeout(10_000) });
if (!mirror.ok || (await mirror.json() as { evm_address?: string }).evm_address?.toLowerCase() !== account.address.toLowerCase()) throw new Error("feedback signer must be the recorded x402 payer");
const transport = http(e.HEDERA_JSON_RPC_URL ?? "https://testnet.hashio.io/api");
const pub = createPublicClient({ chain: hederaTestnet, transport });
if (await pub.getChainId() !== 296) throw new Error("feedback requires Hedera testnet");
const { request } = await pub.simulateContract({ account, address: getAddress(e.ERC8004_REPUTATION_REGISTRY), abi: REPUTATION_ABI, functionName: "giveFeedback",
  args: [BigInt(e.ERC8004_AGENT_ID), BigInt(score), 0, "inference", "x402", new URL("/v1/chat/completions", e.GATEWAY_URL).toString(), uri, keccak256(toBytes(canonicalJson(receipt)))] });
if (!values.broadcast) console.log(JSON.stringify({ preview: true, score, receipt: uri, payment_id: receipt.x402_tx }));
else {
  const wallet = createWalletClient({ account, chain: hederaTestnet, transport });
  const hash = await wallet.writeContract(request);
  const result = await pub.waitForTransactionReceipt({ hash });
  if (result.status !== "success") throw new Error(`feedback reverted: ${hash}`);
  console.log(JSON.stringify({ hash, receipt: uri, payment_id: receipt.x402_tx }));
}
