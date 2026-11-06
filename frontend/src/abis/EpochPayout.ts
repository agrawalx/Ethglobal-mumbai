/* Placeholder ABI for EpochPayout.sol, written from the interface in spec v0.1 §10.5.
   Replace with the compiled ABI once contracts/ has the contract. Amounts are tinybars
   (msg.value inside the Hedera EVM); claim() sends no value. */
export const epochPayoutAbi = [
  {
    type: "function",
    name: "claim",
    stateMutability: "nonpayable",
    inputs: [
      { name: "epoch", type: "uint64" },
      { name: "amount", type: "uint256" },
      { name: "proof", type: "bytes32[]" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "hasClaimed",
    stateMutability: "view",
    inputs: [
      { name: "epoch", type: "uint64" },
      { name: "account", type: "address" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    type: "function",
    name: "epochs",
    stateMutability: "view",
    inputs: [{ name: "epoch", type: "uint64" }],
    outputs: [
      { name: "root", type: "bytes32" },
      { name: "total", type: "uint256" },
      { name: "claimed", type: "uint256" },
      { name: "postedAt", type: "uint64" },
    ],
  },
  {
    type: "event",
    name: "EpochPosted",
    inputs: [
      { name: "epoch", type: "uint64", indexed: true },
      { name: "root", type: "bytes32", indexed: false },
      { name: "total", type: "uint256", indexed: false },
    ],
  },
  {
    type: "event",
    name: "Claimed",
    inputs: [
      { name: "epoch", type: "uint64", indexed: true },
      { name: "account", type: "address", indexed: true },
      { name: "amount", type: "uint256", indexed: false },
    ],
  },
] as const;
