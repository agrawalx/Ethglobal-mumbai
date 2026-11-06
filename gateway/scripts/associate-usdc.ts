/** Associate the actual treasury with configured testnet USDC. Preview unless --broadcast. */
import { parseArgs } from "node:util";
import { Client, PrivateKey, TokenAssociateTransaction } from "@hiero-ledger/sdk";
import { loadNetworkConfig } from "../src/config.ts";

const { values } = parseArgs({ options: { broadcast: { type: "boolean", default: false } } });
const e = process.env;
if ((e.HEDERA_NETWORK ?? "testnet") !== "testnet") throw new Error("USDC association requires testnet");
if (!e.TREASURY_ACCOUNT_ID) throw new Error("TREASURY_ACCOUNT_ID is required");
const token = loadNetworkConfig().x402_usdc.token_id;
const response = await fetch(new URL(`/api/v1/accounts/${e.TREASURY_ACCOUNT_ID}/tokens?token.id=${token}`, e.HEDERA_MIRROR_URL ?? "https://testnet.mirrornode.hedera.com"), { signal: AbortSignal.timeout(10_000) });
if (!response.ok) throw new Error(`mirror returned HTTP ${response.status}`);
const associated = ((await response.json()) as { tokens?: { token_id: string }[] }).tokens?.some((t) => t.token_id === token) ?? false;
if (associated || !values.broadcast) console.log(JSON.stringify({ account: e.TREASURY_ACCOUNT_ID, token, already_associated: associated, preview: !values.broadcast }));
else {
  if (!e.TREASURY_PRIVATE_KEY) throw new Error("TREASURY_PRIVATE_KEY is required for --broadcast");
  const client = Client.forTestnet();
  client.setOperator(e.TREASURY_ACCOUNT_ID, PrivateKey.fromStringECDSA(e.TREASURY_PRIVATE_KEY));
  try {
    const tx = await new TokenAssociateTransaction().setAccountId(e.TREASURY_ACCOUNT_ID).setTokenIds([token]).execute(client);
    const receipt = await tx.getReceipt(client);
    if (receipt.status.toString() !== "SUCCESS" && receipt.status.toString() !== "TOKEN_ALREADY_ASSOCIATED_TO_ACCOUNT") throw new Error(`association failed: ${receipt.status}`);
    console.log(JSON.stringify({ account: e.TREASURY_ACCOUNT_ID, token, transaction: tx.transactionId.toString(), status: receipt.status.toString() }));
  } finally { client.close(); }
}
