# contracts (C10, Solidity / Foundry)

`src/EpochPayout.sol` (SPEC §10.5): `postEpoch(epoch, root) payable` (only settler, `msg.value` = epoch total),
`claim(epoch, amount, proof)` (once per address per epoch, after `postedAt + claimDelay`), `sweep(epoch)`
(only settler, after `postedAt + sweepDelay`, returns the unclaimed rest to the settler). HBAR only.

```bash
cd contracts
forge install --no-git foundry-rs/forge-std   # lib/ is git-ignored; --no-git makes no commit
forge build && forge test -vv
# Deploy (needs contracts/.env):
set -a; . ./.env; set +a
forge script script/Deploy.s.sol --rpc-url hedera_testnet --broadcast --slow
# Verify (HashScan reads Sourcify; server-verify.hashscan.io now redirects to sourcify.dev):
forge verify-contract --chain-id 296 --verifier sourcify <address> src/EpochPayout.sol:EpochPayout --watch
```

**Deployed (step 1.3, 6 Nov 2026):** `0x22aafc9cbdafd4e5a7e7eae47b27cad48ad8b82c` (`0.0.11332808`),
tx `0x66ac3aeb794a2c739c61960ac336e351c0e44eaad54be2685873d221707163db`, Sourcify **exact match**.
HashScan: https://hashscan.io/testnet/contract/0.0.11332808. Read back: `settler()` = `0x14ff4f7615ef8e3cca82adf879f3be4051780a94`, `claimDelay()` = 60, `sweepDelay()` = 604800.

Decisions where the spec is silent:
- `sweepDelay` is a constructor immutable (`SWEEP_DELAY_SECONDS`, default 7 days). After a sweep, `claimed = total`, so no more claims or sweeps for that epoch.
- `postEpoch` rejects a zero root, `msg.value == 0` (epochs without x402 income are not posted), and a re-post.
- No OpenZeppelin: the sorted-pair verify (`verify`, same result as OZ `MerkleProof.verify`) and the reentrancy guard are a few lines.
- `evm_version = shanghai` (pinned for the Hedera EVM).

**Units (Hedera):** inside the EVM, `msg.value` and balances are **tinybars** (1 HBAR = 1e8). JSON-RPC shows **weibars** (1e18),
so the settlement job sends a tx `value` of `total_tinybar × 10^10` weibars. The contract does no conversion
(`test_units_tinybarsInTinybarsOut`).

Merkle rules: `shared/README.md` "Merkle tree". Cross-language vector: `test/fixtures/merkle-vector.json`
(3 leaves + 1-leaf case, generated with `cast`), checked by `test_vector_*`. The gateway's TS tree builder (step 3.3) must reproduce it.
