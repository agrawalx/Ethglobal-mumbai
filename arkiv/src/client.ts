import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { createPublicClient, createWalletClient, type PublicArkivClient, type WalletArkivClient } from "@arkiv-network/sdk";
import { rabdi } from "@arkiv-network/sdk/chains";
import { http, isHex, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";

/**
 * Env (arkiv/.env.example):
 *   ARKIV_ACCESS_KEY   from hub.arkiv.network/access-keys; appended to the RPC URL path. Empty = public, rate-limited endpoint.
 *   ARKIV_RPC_URL      default https://rpc.rabdi.db-chain.testnet.arkiv.network
 *   ARKIV_CHAIN_ID     must be 7794095 (Rabdi testnet)
 *   ARKIV_PRIVATE_KEY  writer key (0x hex), or ARKIV_KEY_PATH = file with the key (node.key / pool.key)
 * Writes cost tGLM gas: fund the writer at hub.arkiv.network/faucet.
 */
export type ArkivEnv = Record<string, string | undefined>;

export const RABDI_CHAIN_ID = 7794095;

function chainFor(env: ArkivEnv) {
  if (env.ARKIV_CHAIN_ID && Number(env.ARKIV_CHAIN_ID) !== RABDI_CHAIN_ID) {
    throw new Error(`ARKIV_CHAIN_ID=${env.ARKIV_CHAIN_ID}: only Rabdi testnet (${RABDI_CHAIN_ID}) is supported`);
  }
  const accessKey = env.ARKIV_ACCESS_KEY ?? "";
  const chain = rabdi({ accessKey });
  const base = env.ARKIV_RPC_URL?.replace(/\/+$/, "");
  const url = base ? (accessKey ? `${base}/${encodeURIComponent(accessKey)}` : base) : undefined;
  return { chain, transport: http(url) };
}

export function publicArkiv(env: ArkivEnv = process.env): PublicArkivClient {
  const { chain, transport } = chainFor(env);
  return createPublicClient({ chain, transport });
}

export function writerKey(env: ArkivEnv = process.env): Hex {
  let raw = env.ARKIV_PRIVATE_KEY;
  if (!raw && env.ARKIV_KEY_PATH) {
    const path = env.ARKIV_KEY_PATH.replace(/^~(?=\/)/, homedir());
    raw = readFileSync(path, "utf8").trim();
  }
  if (!raw) throw new Error("no Arkiv writer key: set ARKIV_PRIVATE_KEY or ARKIV_KEY_PATH (see arkiv/.env.example)");
  const key = raw.startsWith("0x") ? raw : `0x${raw}`;
  if (!isHex(key) || key.length !== 66) throw new Error("Arkiv writer key must be 32 bytes hex");
  return key;
}

export function walletArkiv(env: ArkivEnv = process.env): WalletArkivClient {
  const { chain, transport } = chainFor(env);
  return createWalletClient({ chain, transport, account: privateKeyToAccount(writerKey(env)) });
}
