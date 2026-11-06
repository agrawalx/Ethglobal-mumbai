/** Typed access to public build-time config. Never put secrets in VITE_* vars. */
// `?? {}` so plain node (npm test) can import modules that read config.
const raw: Record<string, unknown> = import.meta.env ?? {};

export const env = {
  dataMode: (raw.VITE_DATA_MODE === "live" ? "live" : "mock") as "mock" | "live",
  gatewayUrl: (raw.VITE_GATEWAY_URL as string | undefined) || "",
  hederaRpc:
    (raw.VITE_HEDERA_RPC as string | undefined) || "https://testnet.hashio.io/api",
  hcsTopic: (raw.VITE_HCS_TOPIC as string | undefined) || "",
  worldAppId: (raw.VITE_WORLD_APP_ID as string | undefined) || "",
  /** World ID action for login (spec §6.1). */
  worldAction: (raw.VITE_WORLD_ACTION as string | undefined) || "gpupool-account",
  /** EpochPayout.sol on Hedera testnet (spec §10.5). */
  payoutAddr: (raw.VITE_PAYOUT_ADDR as string | undefined) || "",
  /** Hedera mirror node REST base, used to check HCS messages. */
  mirrorUrl: (raw.VITE_MIRROR_URL as string | undefined) || "https://testnet.mirrornode.hedera.com",
} as const;
