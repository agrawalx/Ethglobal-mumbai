import { useMemo, useState } from "react";
import type { ReactNode } from "react";
import { WagmiProvider } from "wagmi";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { HexAddress } from "@shared/types";
import { wagmiConfig } from "./config";
import { DemoWalletContext } from "./demo";
import { DEMO_OWNER } from "../data/mock/fixtures";

const KEY = "gpupool.demoWallet";
const read = () => {
  try {
    return sessionStorage.getItem(KEY) === "1";
  } catch {
    return false;
  }
};
const write = (on: boolean) => {
  try {
    if (on) sessionStorage.setItem(KEY, "1");
    else sessionStorage.removeItem(KEY);
  } catch {
    /* storage blocked: demo wallet just won't persist */
  }
};

export default function Providers({ children }: { children: ReactNode }) {
  const [client] = useState(() => new QueryClient());
  const [demoOn, setDemoOn] = useState(read);
  const demo = useMemo(
    () => ({
      address: demoOn ? (DEMO_OWNER as HexAddress) : null,
      connect: () => {
        write(true);
        setDemoOn(true);
      },
      disconnect: () => {
        write(false);
        setDemoOn(false);
      },
    }),
    [demoOn],
  );
  return (
    <WagmiProvider config={wagmiConfig}>
      <QueryClientProvider client={client}>
        <DemoWalletContext.Provider value={demo}>{children}</DemoWalletContext.Provider>
      </QueryClientProvider>
    </WagmiProvider>
  );
}
