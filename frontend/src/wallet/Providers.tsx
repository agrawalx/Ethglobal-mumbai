import { useState, type ReactNode } from "react";
import { WagmiProvider } from "wagmi";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { wagmiConfig } from "./config";
export default function Providers({ children }: { children: ReactNode }) {
 const [client] = useState(() => new QueryClient());
 return <WagmiProvider config={wagmiConfig}><QueryClientProvider client={client}>{children}</QueryClientProvider></WagmiProvider>;
}
