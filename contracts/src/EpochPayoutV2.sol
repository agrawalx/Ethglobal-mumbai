// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title EpochPayoutV2 (SPEC §16.4 contract extensions)
/// @notice EpochPayout (SPEC §10.5) plus a challenge window with disputes, vesting, clawback to a
///         treasury, and on-chain checks of the settler. New deployment: V1 stays as it is.
///
///  Lifecycle of an epoch
///    postEpoch ─► Open ──(window ends, unlock passed)──► claim / sweep
///                   │
///        challenge  ▼   (watcher, once, inside the window)
///               Challenged ──resolve(newRoot,newTotal)──► Open  (difference → treasury; Voided if newRoot = 0)
///                          └─dismiss (owner, or anyone after disputeTimeout)──► Open
///
///  Settler checks (on-chain, so a wrong gateway cannot post silently):
///   - only an allowed settler; each settler owns one namespace: epoch >> 32 == gatewayIndex
///     (index 0 = the single gateway of the MVP, epoch ids unchanged);
///   - total (argument) must equal msg.value, > 0, and ≤ maxEpochTotal;
///   - hcsSeq (sequence of the signed `epoch_closed` HCS event) must be greater than the settler's last
///     one, so every post points at its audit message and old messages cannot be replayed;
///   - vesting: `unlockAt` ≤ now + maxVesting (a settler cannot lock funds for ever).
///
/// @dev Units: every amount is the native EVM unit. On Hedera that is TINYBARS (1 HBAR = 1e8).
///      Merkle rules are those of V1 (shared/README.md "Merkle tree"): leaf = keccak256(abi.encodePacked(address, uint256)),
///      sorted pairs. Vesting is per epoch (all leaves unlock at the same time).
contract EpochPayoutV2 {
    enum State { None, Open, Challenged, Voided }

    struct Epoch {
        bytes32 root;
        uint256 total;      // value held for this epoch (after a resolve: the corrected total)
        uint256 claimed;
        uint64 postedAt;
        uint64 unlockAt;    // vesting: no claim before this (0 = none)
        uint64 challengedAt;
        uint64 hcsSeq;
        State state;
        bool challengedOnce; // one dispute per epoch: no endless re-challenge
    }

    // ---------- immutable policy ----------
    address public immutable treasury;       // receives swept and clawed-back value
    uint64 public immutable challengeWindow; // seconds after post during which claims are closed and a watcher may challenge
    uint64 public immutable disputeTimeout;  // after this, anyone can dismiss an unresolved challenge
    uint64 public immutable sweepDelay;      // seconds after max(post, unlock) before unclaimed value can be swept
    uint64 public immutable maxVesting;      // longest allowed unlock delay
    uint256 public immutable maxEpochTotal;  // 0 = no cap

    // ---------- roles ----------
    address public owner; // resolves disputes, manages settlers and watchers (later: a multisig)
    mapping(address => bool) public isSettler;
    mapping(address => uint32) public gatewayOf;
    mapping(address => bool) public isWatcher;
    mapping(uint32 => uint64) public lastHcsSeq; // per gateway index

    mapping(uint64 => Epoch) public epochs;
    mapping(uint64 => mapping(address => bool)) public hasClaimed;

    uint256 private _lock = 1;

    event EpochPosted(uint64 indexed epoch, address indexed settler, bytes32 root, uint256 total, uint64 hcsSeq, uint64 unlockAt);
    event Claimed(uint64 indexed epoch, address indexed account, uint256 amount);
    event Swept(uint64 indexed epoch, uint256 amount);
    event Challenged(uint64 indexed epoch, address indexed watcher, bytes32 evidence);
    event Resolved(uint64 indexed epoch, bytes32 newRoot, uint256 newTotal, uint256 refunded, bytes32 evidence);
    event Dismissed(uint64 indexed epoch, address indexed by);
    event SettlerSet(address indexed settler, uint32 gatewayIndex, bool allowed);
    event WatcherSet(address indexed watcher, bool allowed);
    event OwnerChanged(address indexed owner);

    error NotOwner();
    error NotSettler();
    error NotWatcher();
    error WrongNamespace(uint32 expected);
    error ZeroRoot();
    error ZeroTotal();
    error TotalMismatch();
    error OverCap();
    error StaleHcsSeq(uint64 last);
    error VestingTooLong();
    error EpochAlreadyPosted(uint64 epoch);
    error EpochNotPosted(uint64 epoch);
    error WrongState(State state);
    error WindowClosed();
    error AlreadyChallenged();
    error ClaimNotOpen(uint64 opensAt);
    error AlreadyClaimed();
    error InvalidProof();
    error OverClaim();
    error BadResolution();
    error SweepNotOpen(uint64 opensAt);
    error NothingToSweep();
    error TransferFailed();
    error Reentrancy();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier nonReentrant() {
        if (_lock != 1) revert Reentrancy();
        _lock = 2;
        _;
        _lock = 1;
    }

    constructor(
        address owner_,
        address treasury_,
        address settler_,
        uint32 gatewayIndex_,
        uint64 challengeWindow_,
        uint64 disputeTimeout_,
        uint64 sweepDelay_,
        uint64 maxVesting_,
        uint256 maxEpochTotal_
    ) {
        owner = owner_;
        treasury = treasury_;
        challengeWindow = challengeWindow_;
        disputeTimeout = disputeTimeout_;
        sweepDelay = sweepDelay_;
        maxVesting = maxVesting_;
        maxEpochTotal = maxEpochTotal_;
        isSettler[settler_] = true;
        gatewayOf[settler_] = gatewayIndex_;
        emit SettlerSet(settler_, gatewayIndex_, true);
        emit OwnerChanged(owner_);
    }

    // ---------- administration ----------

    function setSettler(address settler, uint32 gatewayIndex, bool allowed) external onlyOwner {
        isSettler[settler] = allowed;
        gatewayOf[settler] = gatewayIndex;
        emit SettlerSet(settler, gatewayIndex, allowed);
    }

    function setWatcher(address watcher, bool allowed) external onlyOwner {
        isWatcher[watcher] = allowed;
        emit WatcherSet(watcher, allowed);
    }

    function transferOwnership(address newOwner) external onlyOwner {
        owner = newOwner;
        emit OwnerChanged(newOwner);
    }

    // ---------- views ----------

    /// @notice First second at which claims can be made (window and vesting both over).
    function opensAt(uint64 epoch) public view returns (uint64) {
        Epoch storage e = epochs[epoch];
        uint64 w = e.postedAt + challengeWindow;
        return e.unlockAt > w ? e.unlockAt : w;
    }

    /// @notice First second at which unclaimed value can be swept to the treasury.
    function sweepOpensAt(uint64 epoch) public view returns (uint64) {
        Epoch storage e = epochs[epoch];
        uint64 base = e.unlockAt > e.postedAt ? e.unlockAt : e.postedAt;
        return base + sweepDelay;
    }

    // ---------- settler ----------

    /// @notice Post the payout root of an epoch. msg.value = epoch total (tinybars on Hedera).
    /// @param hcsSeq sequence number of the signed `epoch_closed` message on the HCS topic.
    /// @param unlockAt vesting: no claim before this time (0 = only the challenge window applies).
    function postEpoch(uint64 epoch, bytes32 root, uint256 total, uint64 hcsSeq, uint64 unlockAt) external payable {
        if (!isSettler[msg.sender]) revert NotSettler();
        uint32 gw = gatewayOf[msg.sender];
        if (uint32(epoch >> 32) != gw) revert WrongNamespace(gw);
        if (root == bytes32(0)) revert ZeroRoot();
        if (total == 0 || msg.value == 0) revert ZeroTotal();
        if (total != msg.value) revert TotalMismatch();
        if (maxEpochTotal != 0 && total > maxEpochTotal) revert OverCap();
        if (hcsSeq <= lastHcsSeq[gw]) revert StaleHcsSeq(lastHcsSeq[gw]);
        if (unlockAt > block.timestamp + maxVesting) revert VestingTooLong();
        if (epochs[epoch].state != State.None) revert EpochAlreadyPosted(epoch);

        lastHcsSeq[gw] = hcsSeq;
        epochs[epoch] = Epoch({
            root: root,
            total: total,
            claimed: 0,
            postedAt: uint64(block.timestamp),
            unlockAt: unlockAt,
            challengedAt: 0,
            hcsSeq: hcsSeq,
            state: State.Open,
            challengedOnce: false
        });
        emit EpochPosted(epoch, msg.sender, root, total, hcsSeq, unlockAt);
    }

    // ---------- disputes ----------

    /// @notice A watcher blocks an epoch inside its window (once per epoch). `evidence` = hash of the
    ///         verification record (SPEC §16.2) that shows the problem.
    function challenge(uint64 epoch, bytes32 evidence) external {
        if (!isWatcher[msg.sender]) revert NotWatcher();
        Epoch storage e = epochs[epoch];
        if (e.state != State.Open) revert WrongState(e.state);
        if (e.challengedOnce) revert AlreadyChallenged();
        if (block.timestamp >= e.postedAt + challengeWindow) revert WindowClosed();
        e.state = State.Challenged;
        e.challengedOnce = true;
        e.challengedAt = uint64(block.timestamp);
        emit Challenged(epoch, msg.sender, evidence);
    }

    /// @notice Owner decides a dispute: replace the root and total with a corrected tree. The difference
    ///         (clawback of fraudulent or unvested payouts) goes to the treasury. newRoot = 0 voids the epoch.
    function resolve(uint64 epoch, bytes32 newRoot, uint256 newTotal, bytes32 evidence) external onlyOwner nonReentrant {
        Epoch storage e = epochs[epoch];
        if (e.state != State.Challenged) revert WrongState(e.state);
        if (newTotal > e.total) revert BadResolution();
        if ((newRoot == bytes32(0)) != (newTotal == 0)) revert BadResolution();
        uint256 refund = e.total - newTotal;
        e.root = newRoot;
        e.total = newTotal;
        e.state = newRoot == bytes32(0) ? State.Voided : State.Open;
        emit Resolved(epoch, newRoot, newTotal, refund, evidence);
        if (refund > 0) {
            (bool ok,) = payable(treasury).call{value: refund}("");
            if (!ok) revert TransferFailed();
        }
    }

    /// @notice Reject a challenge. The owner at any time; anyone after disputeTimeout (an owner that
    ///         never answers cannot lock the funds).
    function dismiss(uint64 epoch) external {
        Epoch storage e = epochs[epoch];
        if (e.state != State.Challenged) revert WrongState(e.state);
        if (msg.sender != owner && block.timestamp < e.challengedAt + disputeTimeout) revert NotOwner();
        e.state = State.Open;
        emit Dismissed(epoch, msg.sender);
    }

    // ---------- providers ----------

    /// @notice Claim the caller's payout for an epoch. Pays msg.sender.
    function claim(uint64 epoch, uint256 amount, bytes32[] calldata proof) external nonReentrant {
        Epoch storage e = epochs[epoch];
        if (e.state == State.None) revert EpochNotPosted(epoch);
        if (e.state != State.Open) revert WrongState(e.state);
        uint64 at = opensAt(epoch);
        if (block.timestamp < at) revert ClaimNotOpen(at);
        if (hasClaimed[epoch][msg.sender]) revert AlreadyClaimed();
        bytes32 leaf = keccak256(abi.encodePacked(msg.sender, amount));
        if (!verify(proof, e.root, leaf)) revert InvalidProof();
        if (e.claimed + amount > e.total) revert OverClaim();

        hasClaimed[epoch][msg.sender] = true;
        e.claimed += amount;
        emit Claimed(epoch, msg.sender, amount);

        (bool ok,) = payable(msg.sender).call{value: amount}("");
        if (!ok) revert TransferFailed();
    }

    /// @notice Anyone can return the unclaimed value of an open epoch to the treasury after sweepDelay
    ///         (so a scheduled transaction can do it with no key held by the gateway).
    function sweep(uint64 epoch) external nonReentrant {
        Epoch storage e = epochs[epoch];
        if (e.state == State.None) revert EpochNotPosted(epoch);
        if (e.state != State.Open) revert WrongState(e.state);
        uint64 at = sweepOpensAt(epoch);
        if (block.timestamp < at) revert SweepNotOpen(at);
        uint256 rest = e.total - e.claimed;
        if (rest == 0) revert NothingToSweep();
        e.claimed = e.total;
        emit Swept(epoch, rest);
        (bool ok,) = payable(treasury).call{value: rest}("");
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
