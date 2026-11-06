import { createContext, useContext } from "react";
import type { HexAddress } from "@shared/types";

/** Mock mode only: a clearly-labelled demo wallet for machines without MetaMask. */
export type DemoWallet = { address: HexAddress | null; connect: () => void; disconnect: () => void };
export const DemoWalletContext = createContext<DemoWallet>({ address: null, connect: () => {}, disconnect: () => {} });
export const useDemoWallet = () => useContext(DemoWalletContext);
