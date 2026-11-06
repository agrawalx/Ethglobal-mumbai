import { useBalance, useConnect, useConnection, useConnectors, useDisconnect, useSwitchChain } from "wagmi";
import type { HexAddress } from "@shared/types";
import { hederaTestnet } from "./config";
import { useDemoWallet } from "./demo";
import { env } from "../config/env";

/**
 * One wallet view for the console: a real injected wallet (MetaMask) on Hedera testnet,
 * or, in mock mode only, a labelled demo wallet.
 */
export function useWallet() {
  const conn = useConnection();
  const connectors = useConnectors();
  const connect = useConnect();
  const disconnect = useDisconnect();
  const switchChain = useSwitchChain();
  const demo = useDemoWallet();
  const real = conn.status === "connected" ? (conn.address as HexAddress) : null;
  const balance = useBalance({ address: real ?? undefined, chainId: hederaTestnet.id, query: { enabled: !!real } });
  const injected = connectors.find((c) => c.type === "injected");
  const hasInjected = typeof window !== "undefined" && "ethereum" in window;

  const address = real ?? demo.address;
  const isDemo = !real && !!demo.address;
  const wrongChain = !!real && conn.chainId !== hederaTestnet.id;

  return {
    address,
    isDemo,
    connected: !!address,
    wrongChain,
    hasInjected,
    canUseDemo: env.dataMode === "mock",
    connecting: connect.isPending || conn.status === "connecting" || conn.status === "reconnecting",
    switching: switchChain.isPending,
    error: connect.error ?? switchChain.error ?? null,
    /** Native balance in HBAR (JSON-RPC 18 decimals), real wallets only. */
    balanceHbar: balance.data ? Number(balance.data.value) / 10 ** balance.data.decimals : null,
    async connectInjected() {
      if (!injected) throw new Error("No browser wallet found. Install MetaMask, or use the demo wallet.");
      await connect.mutateAsync({ connector: injected, chainId: hederaTestnet.id });
    },
    connectDemo: demo.connect,
    async switchToHedera() {
      await switchChain.mutateAsync({ chainId: hederaTestnet.id });
    },
    disconnect() {
      if (real) disconnect.mutate({});
      demo.disconnect();
    },
  };
}
