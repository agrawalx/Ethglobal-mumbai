import { canonicalJson, MerkleLeaf, type PayoutProof } from "@gpupool/shared";
import { concatHex, encodePacked, keccak256, toBytes, type Hex } from "viem";

export const ZERO_ROOT: Hex = `0x${"0".repeat(64)}`;
export const payoutLeaf = (address: Hex, amount: bigint): Hex => keccak256(encodePacked(["address", "uint256"], [address, amount]));
export const pairHash = (a: Hex, b: Hex): Hex => keccak256(concatHex(a < b ? [a, b] : [b, a]));

/** One leaf per address; zero amounts omitted; odd nodes promoted unchanged (shared vector). */
export function payoutTree(epoch: number, input: MerkleLeaf[]): { root: Hex; hash: Hex; payouts: MerkleLeaf[]; proofs: PayoutProof[] } {
  const amounts = new Map<Hex, bigint>();
  for (const raw of input) {
    const p = MerkleLeaf.parse(raw);
    const address = p.payout_address as Hex;
    amounts.set(address, (amounts.get(address) ?? 0n) + BigInt(p.amount_tinybar));
  }
  const payouts = [...amounts].filter(([, amount]) => amount > 0n).sort(([a], [b]) => a.localeCompare(b))
    .map(([payout_address, amount]) => ({ payout_address, amount_tinybar: amount.toString() }));
  const sorted = payouts.map((p) => ({ ...p, leaf: payoutLeaf(p.payout_address, BigInt(p.amount_tinybar)) })).sort((a, b) => a.leaf.localeCompare(b.leaf));
  const levels: Hex[][] = [sorted.map((p) => p.leaf)];
  while (levels.at(-1)!.length > 1) {
    const previous = levels.at(-1)!;
    const next: Hex[] = [];
    for (let i = 0; i < previous.length; i += 2) next.push(previous[i + 1] ? pairHash(previous[i]!, previous[i + 1]!) : previous[i]!);
    levels.push(next);
  }
  const root = levels.at(-1)![0] ?? ZERO_ROOT;
  const proofs = sorted.map((p, index) => {
    const proof: Hex[] = [];
    for (const level of levels.slice(0, -1)) {
      const sibling = level[index ^ 1];
      if (sibling) proof.push(sibling);
      index = Math.floor(index / 2);
    }
    return { epoch, payout_address: p.payout_address, amount_tinybar: p.amount_tinybar, proof, merkle_root: root };
  });
  return { root, hash: keccak256(toBytes(canonicalJson(payouts))), payouts, proofs };
}

export function verifyPayoutProof(address: Hex, amount: bigint, proof: Hex[], root: Hex): boolean {
  return proof.reduce((hash, sibling) => pairHash(hash, sibling), payoutLeaf(address, amount)) === root;
}
