/** Register once with an existing reference ERC-8004 registry on Hedera testnet. Preview by default. */
import { parseArgs } from "node:util";
import { createPublicClient, createWalletClient, getAddress, http, parseEventLogs } from "viem";
import { hederaTestnet } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";
import { IDENTITY_ABI } from "../src/erc8004.ts";
import { privateKey } from "../src/payout-chain.ts";

const { values } = parseArgs({ options: { broadcast: { type: "boolean", default: false } } });
const e = process.env;
if (!e.ERC8004_IDENTITY_REGISTRY || !e.ERC8004_PRIVATE_KEY || !e.PUBLIC_URL) throw new Error("set ERC8004_IDENTITY_REGISTRY, ERC8004_PRIVATE_KEY and PUBLIC_URL in ignored gateway/.env");
const address = getAddress(e.ERC8004_IDENTITY_REGISTRY);
const account = privateKeyToAccount(privateKey(e.ERC8004_PRIVATE_KEY));
const transport = http(e.HEDERA_JSON_RPC_URL ?? "https://testnet.hashio.io/api");
const pub = createPublicClient({ chain: hederaTestnet, transport });
if (await pub.getChainId() !== 296) throw new Error("ERC-8004 registration requires Hedera testnet");
if (!(await pub.getCode({ address }))) throw new Error("registry address has no deployed contract");
const uri = new URL("/.well-known/agent-registration.json", e.PUBLIC_URL).toString();
const registration = await fetch(uri, { signal: AbortSignal.timeout(10_000) });
if (!registration.ok || (await registration.json() as { type?: string }).type !== "https://eips.ethereum.org/EIPS/eip-8004#registration-v1") throw new Error("PUBLIC_URL does not serve a valid agent registration document");
if (e.ERC8004_AGENT_ID) {
  const id = BigInt(e.ERC8004_AGENT_ID);
  const [owner, currentURI] = await Promise.all([
    pub.readContract({ address, abi: IDENTITY_ABI, functionName: "ownerOf", args: [id] }),
    pub.readContract({ address, abi: IDENTITY_ABI, functionName: "tokenURI", args: [id] }),
  ]);
  if (owner.toLowerCase() !== account.address.toLowerCase() || currentURI !== uri) throw new Error("configured agent registration does not match owner and PUBLIC_URL");
  console.log(JSON.stringify({ already_registered: true, agent_id: id.toString(), uri }));
} else {
  const { request, result } = await pub.simulateContract({ account, address, abi: IDENTITY_ABI, functionName: "register", args: [uri] });
  if (!values.broadcast) console.log(JSON.stringify({ preview: true, expected_agent_id: result.toString(), uri, owner: account.address }));
  else {
    const wallet = createWalletClient({ account, chain: hederaTestnet, transport });
    const hash = await wallet.writeContract(request);
    const receipt = await pub.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") throw new Error(`registration reverted: ${hash}`);
    const event = parseEventLogs({ abi: IDENTITY_ABI, eventName: "Registered", logs: receipt.logs }).find((x) => x.address.toLowerCase() === address.toLowerCase());
    if (!event) throw new Error(`registration succeeded without Registered event: ${hash}`);
    console.log(JSON.stringify({ agent_id: event.args.agentId.toString(), uri, hash, explorer: `https://hashscan.io/testnet/transaction/${hash}` }));
  }
}
