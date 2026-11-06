import { createConfig, http } from "wagmi";
import { injected } from "wagmi/connectors";
import { hederaTestnet as base } from "viem/chains";
import { env } from "../config/env";

/** Hedera testnet (chain 296). Native HBAR is 18 decimals over JSON-RPC; contracts see tinybars (8). */
export const hederaTestnet = {
  ...base,
  rpcUrls: { default: { http: [env.hederaRpc] } },
} as const;

/* WalletConnect is added only when a project id is configured (none yet), so injected wallets only. */
export const wagmiConfig = createConfig({
  chains: [hederaTestnet],
  connectors: [injected()],
  transports: { [hederaTestnet.id]: http(env.hederaRpc) },
});

declare module "wagmi" {
  interface Register {
    config: typeof wagmiConfig;
  }
}
