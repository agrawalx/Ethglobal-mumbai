import { z } from "zod";
import { EpochNumber, EvmAddress, Hex32, Tinybar } from "./common.ts";

/**
 * Epoch payout Merkle tree (SPEC §10.5). The gateway (TS) and EpochPayout.sol must agree:
 *
 * - leaf  = keccak256(abi.encodePacked(address payout_address, uint256 amount_tinybar))
 *           (20 bytes address ‖ 32 bytes big-endian amount)
 * - node  = keccak256(sorted(a, b))  — the smaller 32-byte value first (OpenZeppelin MerkleProof)
 * - one leaf per payout address per epoch; leaves with amount 0 are left out
 * - one-leaf tree: root = leaf, proof = []
 */
export const MERKLE_LEAF_ENCODING = "keccak256(abi.encodePacked(address,uint256))" as const;
export const MERKLE_PAIR_ORDER = "sorted" as const;

export const MerkleLeaf = z.object({
  payout_address: EvmAddress,
  amount_tinybar: Tinybar,
});
export type MerkleLeaf = z.infer<typeof MerkleLeaf>;

/** What a provider needs to call `claim(epoch, amount, proof)`. */
export const PayoutProof = z.object({
  epoch: EpochNumber,
  payout_address: EvmAddress,
  amount_tinybar: Tinybar,
  proof: z.array(Hex32),
  merkle_root: Hex32,
});
export type PayoutProof = z.infer<typeof PayoutProof>;
