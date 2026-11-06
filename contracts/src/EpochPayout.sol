// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title EpochPayout (SPEC §10.5)
/// @notice Minimal MVP contract. No vesting, no disputes, no node registry.
///         The settler posts one Merkle root per epoch and sends the epoch total with the call.
///         Providers claim their leaf once. Trust: the contract trusts the settler for the root;
///         anyone can compare it with the `epoch_closed` event on HCS.
/// @dev Units: every amount (leaf amount, total, msg.value, payouts) is the native unit that the
///      EVM sees. On Hedera that is TINYBARS (1 HBAR = 1e8). The contract does no conversion.
///      Merkle rules (must match shared/README.md "Merkle tree"):
///        leaf = keccak256(abi.encodePacked(address, uint256 amount))
///        pair = keccak256(smaller ‖ larger)   (OpenZeppelin MerkleProof, sorted pairs)
contract EpochPayout {
    struct Epoch {
        bytes32 root;
        uint256 total;
        uint256 claimed;
        uint64 postedAt;
    }

    /// Gateway settlement key. Only it can post and sweep epochs.
    address public immutable settler;
    /// Seconds after postEpoch before claims open (0-300 for the demo).
    uint64 public immutable claimDelay;
    /// Seconds after postEpoch before the settler can sweep unclaimed HBAR back.
    /// SPEC says only "after a long period"; set at deploy (SWEEP_DELAY_SECONDS).
    uint64 public immutable sweepDelay;

    mapping(uint64 => Epoch) public epochs;
    mapping(uint64 => mapping(address => bool)) public hasClaimed;

    uint256 private _lock = 1;

    event EpochPosted(uint64 indexed epoch, bytes32 root, uint256 total);
    event Claimed(uint64 indexed epoch, address indexed account, uint256 amount);
    event Swept(uint64 indexed epoch, uint256 amount);

    error NotSettler();
    error ZeroRoot();
    error ZeroTotal();
    error EpochAlreadyPosted(uint64 epoch);
    error EpochNotPosted(uint64 epoch);
    error ClaimNotOpen(uint64 opensAt);
    error AlreadyClaimed();
    error InvalidProof();
    error OverClaim();
    error SweepNotOpen(uint64 opensAt);
    error NothingToSweep();
    error TransferFailed();
    error Reentrancy();

    modifier onlySettler() {
        if (msg.sender != settler) revert NotSettler();
        _;
    }

    modifier nonReentrant() {
        if (_lock != 1) revert Reentrancy();
        _lock = 2;
        _;
        _lock = 1;
    }

    constructor(address settler_, uint64 claimDelay_, uint64 sweepDelay_) {
        settler = settler_;
        claimDelay = claimDelay_;
        sweepDelay = sweepDelay_;
    }

    /// @notice Post the payout root of an epoch. msg.value = epoch total (tinybars on Hedera).
    ///         An epoch with no income is not posted (msg.value 0 is rejected).
    function postEpoch(uint64 epoch, bytes32 root) external payable onlySettler {
        if (root == bytes32(0)) revert ZeroRoot();
        if (msg.value == 0) revert ZeroTotal();
        if (epochs[epoch].root != bytes32(0)) revert EpochAlreadyPosted(epoch);
        epochs[epoch] = Epoch({root: root, total: msg.value, claimed: 0, postedAt: uint64(block.timestamp)});
        emit EpochPosted(epoch, root, msg.value);
    }

    /// @notice Claim the caller's payout for an epoch. Pays msg.sender.
    function claim(uint64 epoch, uint256 amount, bytes32[] calldata proof) external nonReentrant {
        Epoch storage e = epochs[epoch];
        if (e.root == bytes32(0)) revert EpochNotPosted(epoch);
        uint64 opensAt = e.postedAt + claimDelay;
        if (block.timestamp < opensAt) revert ClaimNotOpen(opensAt);
        if (hasClaimed[epoch][msg.sender]) revert AlreadyClaimed();
        bytes32 leaf = keccak256(abi.encodePacked(msg.sender, amount));
        if (!verify(proof, e.root, leaf)) revert InvalidProof();
        if (e.claimed + amount > e.total) revert OverClaim();

        // Effects before the transfer (checks-effects-interactions), plus the guard.
        hasClaimed[epoch][msg.sender] = true;
        e.claimed += amount;
        emit Claimed(epoch, msg.sender, amount);

        (bool ok,) = payable(msg.sender).call{value: amount}("");
        if (!ok) revert TransferFailed();
    }

    /// @notice Return the unclaimed value of an epoch to the settler, after sweepDelay.
    ///         Claims for the epoch are impossible afterwards (claimed = total).
    function sweep(uint64 epoch) external onlySettler nonReentrant {
        Epoch storage e = epochs[epoch];
        if (e.root == bytes32(0)) revert EpochNotPosted(epoch);
        uint64 opensAt = e.postedAt + sweepDelay;
        if (block.timestamp < opensAt) revert SweepNotOpen(opensAt);
        uint256 rest = e.total - e.claimed;
        if (rest == 0) revert NothingToSweep();
        e.claimed = e.total;
        emit Swept(epoch, rest);

        (bool ok,) = payable(settler).call{value: rest}("");
        if (!ok) revert TransferFailed();
    }

    /// @dev Sorted-pair Merkle verification, same result as OpenZeppelin MerkleProof.verify.
    function verify(bytes32[] calldata proof, bytes32 root, bytes32 leaf) public pure returns (bool) {
        bytes32 h = leaf;
        for (uint256 i = 0; i < proof.length; i++) {
            bytes32 p = proof[i];
            h = h < p ? keccak256(abi.encodePacked(h, p)) : keccak256(abi.encodePacked(p, h));
        }
        return h == root;
    }
}
