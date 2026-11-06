// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {EpochPayoutV2} from "../src/EpochPayoutV2.sol";

/// Claims a second epoch from inside receive(): must hit the reentrancy guard.
contract Reenterer2 {
    EpochPayoutV2 public target;
    uint64 public epoch2;
    uint256 public amount2;
    bytes32[] public proof2;
    bool public tried;

    constructor(EpochPayoutV2 t) { target = t; }

    function arm(uint64 e, uint256 a, bytes32[] calldata p) external {
        epoch2 = e;
        amount2 = a;
        proof2 = p;
    }

    function claim(uint64 e, uint256 a, bytes32[] calldata p) external { target.claim(e, a, p); }

    receive() external payable {
        if (tried) return;
        tried = true;
        target.claim(epoch2, amount2, proof2);
    }
}

contract EpochPayoutV2Test is Test {
    EpochPayoutV2 payout;
    address owner = makeAddr("owner");
    address treasury = makeAddr("treasury");
    address settler = makeAddr("settler");
    address watcher = makeAddr("watcher");
    address stranger = makeAddr("stranger");

    uint64 constant WINDOW = 1 hours;
    uint64 constant DISPUTE_TIMEOUT = 2 days;
    uint64 constant SWEEP_DELAY = 7 days;
    uint64 constant MAX_VESTING = 30 days;
    uint256 constant CAP = 1_000 ether;
    uint64 constant EPOCH = 2989853; // gateway 0
    uint64 constant HCS = 1000;
    bytes32 constant EVIDENCE = keccak256("verification ver_01");

    struct Leaf {
        address account;
        uint256 amount;
        bytes32 leaf;
        bytes32[] proof;
    }

    bytes32 root;
    Leaf[3] leaves;
    uint256 total;

    function setUp() public {
        payout = new EpochPayoutV2(owner, treasury, settler, 0, WINDOW, DISPUTE_TIMEOUT, SWEEP_DELAY, MAX_VESTING, CAP);
        vm.deal(settler, 100 ether);
        vm.prank(owner);
        payout.setWatcher(watcher, true);
        string memory json = vm.readFile("test/fixtures/merkle-vector.json");
        root = vm.parseJsonBytes32(json, ".root");
        for (uint256 i = 0; i < 3; i++) {
            string memory p = string.concat(".leaves[", vm.toString(i), "]");
            leaves[i].account = vm.parseJsonAddress(json, string.concat(p, ".payout_address"));
            leaves[i].amount = vm.parseUint(vm.parseJsonString(json, string.concat(p, ".amount_tinybar")));
            leaves[i].leaf = vm.parseJsonBytes32(json, string.concat(p, ".leaf"));
            bytes32[] memory proof = vm.parseJsonBytes32Array(json, string.concat(p, ".proof"));
            for (uint256 j = 0; j < proof.length; j++) leaves[i].proof.push(proof[j]);
            total += leaves[i].amount;
        }
    }

    function _post(uint64 epoch, bytes32 r, uint256 value, uint64 seq, uint64 unlock) internal {
        vm.prank(settler);
        payout.postEpoch{value: value}(epoch, r, value, seq, unlock);
    }

    function _postDefault() internal { _post(EPOCH, root, total, HCS, 0); }

    function _claim(uint256 i) internal {
        vm.prank(leaves[i].account);
        payout.claim(EPOCH, leaves[i].amount, leaves[i].proof);
    }

    function _pair(bytes32 a, bytes32 b) internal pure returns (bytes32) {
        return a < b ? keccak256(abi.encodePacked(a, b)) : keccak256(abi.encodePacked(b, a));
    }

    function _state(uint64 epoch) internal view returns (EpochPayoutV2.State s) {
        (,,,,,,, s,) = payout.epochs(epoch);
    }

    function _claimed(uint64 epoch) internal view returns (uint256 c) {
        (, , c,,,,,,) = payout.epochs(epoch);
    }

    // ---------- on-chain settler checks ----------

    function test_post_storesEpochAndLinksHcs() public {
        vm.expectEmit(true, true, false, true);
        emit EpochPayoutV2.EpochPosted(EPOCH, settler, root, total, HCS, 0);
        _postDefault();
        (bytes32 r, uint256 t, uint256 c, uint64 at, uint64 unlock,, uint64 seq, EpochPayoutV2.State s, bool once) = payout.epochs(EPOCH);
        assertEq(r, root);
        assertEq(t, total);
        assertEq(c, 0);
        assertEq(at, block.timestamp);
        assertEq(unlock, 0);
        assertEq(seq, HCS);
        assertTrue(s == EpochPayoutV2.State.Open);
        assertFalse(once);
        assertEq(address(payout).balance, total, "tinybars held");
        assertEq(payout.lastHcsSeq(0), HCS);
    }

    function test_post_onlyAllowedSettler() public {
        vm.deal(stranger, total);
        vm.prank(stranger);
        vm.expectRevert(EpochPayoutV2.NotSettler.selector);
        payout.postEpoch{value: total}(EPOCH, root, total, HCS, 0);
    }

    function test_post_totalMustEqualValue() public {
        vm.prank(settler);
        vm.expectRevert(EpochPayoutV2.TotalMismatch.selector);
        payout.postEpoch{value: total}(EPOCH, root, total + 1, HCS, 0);
    }

    function test_post_rejectsZeroRootZeroTotalAndCap() public {
        vm.deal(settler, CAP + 1);
        vm.startPrank(settler);
        vm.expectRevert(EpochPayoutV2.ZeroRoot.selector);
        payout.postEpoch{value: total}(EPOCH, bytes32(0), total, HCS, 0);
        vm.expectRevert(EpochPayoutV2.ZeroTotal.selector);
        payout.postEpoch{value: 0}(EPOCH, root, 0, HCS, 0);
        vm.expectRevert(EpochPayoutV2.OverCap.selector);
        payout.postEpoch{value: CAP + 1}(EPOCH, root, CAP + 1, HCS, 0);
        vm.stopPrank();
    }

    function test_post_hcsSequenceMustIncrease() public {
        _postDefault();
        vm.prank(settler);
        vm.expectRevert(abi.encodeWithSelector(EpochPayoutV2.StaleHcsSeq.selector, HCS));
        payout.postEpoch{value: total}(EPOCH + 1, root, total, HCS, 0);
        _post(EPOCH + 1, root, total, HCS + 1, 0);
        assertEq(payout.lastHcsSeq(0), HCS + 1);
    }

    function test_post_rejectsRepostAndLongVesting() public {
        _postDefault();
        vm.prank(settler);
        vm.expectRevert(abi.encodeWithSelector(EpochPayoutV2.EpochAlreadyPosted.selector, EPOCH));
        payout.postEpoch{value: total}(EPOCH, root, total, HCS + 1, 0);
        vm.prank(settler);
        vm.expectRevert(EpochPayoutV2.VestingTooLong.selector);
        payout.postEpoch{value: total}(EPOCH + 1, root, total, HCS + 1, uint64(block.timestamp) + MAX_VESTING + 1);
    }

    function test_namespaces_separateGateways() public {
        address settler2 = makeAddr("settler2");
        vm.deal(settler2, 10 ether);
        vm.prank(owner);
        payout.setSettler(settler2, 1, true);
        uint64 epoch1 = (uint64(1) << 32) + 7;
        // gateway 1 cannot post gateway 0's namespace, and gateway 0 cannot post gateway 1's.
        vm.prank(settler2);
        vm.expectRevert(abi.encodeWithSelector(EpochPayoutV2.WrongNamespace.selector, uint32(1)));
        payout.postEpoch{value: total}(EPOCH, root, total, 1, 0);
        vm.prank(settler);
        vm.expectRevert(abi.encodeWithSelector(EpochPayoutV2.WrongNamespace.selector, uint32(0)));
        payout.postEpoch{value: total}(epoch1, root, total, 1, 0);
        // Each has its own HCS sequence line.
        vm.prank(settler2);
        payout.postEpoch{value: total}(epoch1, root, total, 5, 0);
        _post(EPOCH, root, total, 2, 0);
        assertEq(payout.lastHcsSeq(1), 5);
        assertEq(payout.lastHcsSeq(0), 2);
        // A removed settler can no longer post.
        vm.prank(owner);
        payout.setSettler(settler2, 1, false);
        vm.prank(settler2);
        vm.expectRevert(EpochPayoutV2.NotSettler.selector);
        payout.postEpoch{value: total}((uint64(1) << 32) + 8, root, total, 6, 0);
    }

    function test_admin_onlyOwner() public {
        vm.prank(stranger);
        vm.expectRevert(EpochPayoutV2.NotOwner.selector);
        payout.setWatcher(stranger, true);
        vm.prank(stranger);
        vm.expectRevert(EpochPayoutV2.NotOwner.selector);
        payout.setSettler(stranger, 0, true);
        vm.prank(owner);
        payout.transferOwnership(stranger);
        assertEq(payout.owner(), stranger);
    }

    // ---------- challenge window and claims ----------

    function test_claim_closedInsideWindow_openAfter() public {
        _postDefault();
        vm.prank(leaves[0].account);
        vm.expectRevert(abi.encodeWithSelector(EpochPayoutV2.ClaimNotOpen.selector, uint64(block.timestamp) + WINDOW));
        payout.claim(EPOCH, leaves[0].amount, leaves[0].proof);
        vm.warp(block.timestamp + WINDOW - 1);
        vm.prank(leaves[0].account);
        vm.expectRevert();
        payout.claim(EPOCH, leaves[0].amount, leaves[0].proof);
        vm.warp(block.timestamp + 1);
        uint256 before = leaves[0].account.balance;
        _claim(0);
        assertEq(leaves[0].account.balance - before, leaves[0].amount, "tinybar units");
        assertEq(_claimed(EPOCH), leaves[0].amount);
    }

    function test_claim_noDoubleBadProofOrWrongAmount() public {
        _postDefault();
        vm.warp(block.timestamp + WINDOW);
        _claim(0);
        vm.prank(leaves[0].account);
        vm.expectRevert(EpochPayoutV2.AlreadyClaimed.selector);
        payout.claim(EPOCH, leaves[0].amount, leaves[0].proof);
        vm.prank(leaves[1].account);
        vm.expectRevert(EpochPayoutV2.InvalidProof.selector);
        payout.claim(EPOCH, leaves[1].amount + 1, leaves[1].proof);
        vm.prank(stranger);
        vm.expectRevert(EpochPayoutV2.InvalidProof.selector);
        payout.claim(EPOCH, leaves[1].amount, leaves[1].proof);
        vm.prank(leaves[1].account);
        vm.expectRevert(abi.encodeWithSelector(EpochPayoutV2.EpochNotPosted.selector, EPOCH + 9));
        payout.claim(EPOCH + 9, leaves[1].amount, leaves[1].proof);
    }

    function test_vesting_claimOpensAtUnlock() public {
        uint64 unlock = uint64(block.timestamp) + 10 days;
        _post(EPOCH, root, total, HCS, unlock);
        assertEq(payout.opensAt(EPOCH), unlock);
        vm.warp(block.timestamp + WINDOW + 1 days); // window over, vesting not
        vm.prank(leaves[0].account);
        vm.expectRevert(abi.encodeWithSelector(EpochPayoutV2.ClaimNotOpen.selector, unlock));
        payout.claim(EPOCH, leaves[0].amount, leaves[0].proof);
        vm.warp(unlock);
        _claim(0);
    }

    // ---------- disputes and clawback ----------

    function test_challenge_blocksClaims_onlyWatcher_onlyInsideWindow_once() public {
        _postDefault();
        vm.prank(stranger);
        vm.expectRevert(EpochPayoutV2.NotWatcher.selector);
        payout.challenge(EPOCH, EVIDENCE);
        vm.expectEmit(true, true, false, true);
        emit EpochPayoutV2.Challenged(EPOCH, watcher, EVIDENCE);
        vm.prank(watcher);
        payout.challenge(EPOCH, EVIDENCE);
        assertTrue(_state(EPOCH) == EpochPayoutV2.State.Challenged);
        vm.warp(block.timestamp + WINDOW + 1 days);
        vm.prank(leaves[0].account);
        vm.expectRevert(abi.encodeWithSelector(EpochPayoutV2.WrongState.selector, EpochPayoutV2.State.Challenged));
        payout.claim(EPOCH, leaves[0].amount, leaves[0].proof);
        // A second challenge is impossible, and so is a late one on another epoch.
        vm.prank(watcher);
        vm.expectRevert(abi.encodeWithSelector(EpochPayoutV2.WrongState.selector, EpochPayoutV2.State.Challenged));
        payout.challenge(EPOCH, EVIDENCE);
        _post(EPOCH + 1, root, total, HCS + 1, 0);
        vm.warp(block.timestamp + WINDOW);
        vm.prank(watcher);
        vm.expectRevert(EpochPayoutV2.WindowClosed.selector);
        payout.challenge(EPOCH + 1, EVIDENCE);
    }

    function test_resolve_clawsBackDifferenceToTreasury_newTreeClaims_oldProofFails() public {
        _postDefault();
        vm.prank(watcher);
        payout.challenge(EPOCH, EVIDENCE);
        // Corrected tree: leaf 2 (the fraudulent provider) removed.
        bytes32 newRoot = _pair(leaves[0].leaf, leaves[1].leaf);
        uint256 newTotal = leaves[0].amount + leaves[1].amount;
        uint256 refund = total - newTotal;
        assertEq(refund, leaves[2].amount);
        vm.prank(stranger);
        vm.expectRevert(EpochPayoutV2.NotOwner.selector);
        payout.resolve(EPOCH, newRoot, newTotal, EVIDENCE);
        vm.expectEmit(true, false, false, true);
        emit EpochPayoutV2.Resolved(EPOCH, newRoot, newTotal, refund, EVIDENCE);
        vm.prank(owner);
        payout.resolve(EPOCH, newRoot, newTotal, EVIDENCE);
        assertEq(treasury.balance, refund, "clawback to treasury");
        assertEq(address(payout).balance, newTotal);
        assertTrue(_state(EPOCH) == EpochPayoutV2.State.Open);
        vm.warp(block.timestamp + WINDOW);
        // Providers 0 and 1 claim with new proofs; the removed provider and old proofs fail.
        bytes32[] memory p0 = new bytes32[](1);
        p0[0] = leaves[1].leaf;
        bytes32[] memory p1 = new bytes32[](1);
        p1[0] = leaves[0].leaf;
        vm.prank(leaves[0].account);
        payout.claim(EPOCH, leaves[0].amount, p0);
        vm.prank(leaves[1].account);
        payout.claim(EPOCH, leaves[1].amount, p1);
        vm.prank(leaves[2].account);
        vm.expectRevert(EpochPayoutV2.InvalidProof.selector);
        payout.claim(EPOCH, leaves[2].amount, leaves[2].proof);
        assertEq(address(payout).balance, 0);
    }

    function test_resolve_voidEpoch_refundsEverything() public {
        _postDefault();
        vm.prank(watcher);
        payout.challenge(EPOCH, EVIDENCE);
        vm.prank(owner);
        payout.resolve(EPOCH, bytes32(0), 0, EVIDENCE);
        assertEq(treasury.balance, total);
        assertTrue(_state(EPOCH) == EpochPayoutV2.State.Voided);
        vm.warp(block.timestamp + SWEEP_DELAY + 1);
        vm.expectRevert(abi.encodeWithSelector(EpochPayoutV2.WrongState.selector, EpochPayoutV2.State.Voided));
        payout.sweep(EPOCH);
    }

    function test_resolve_rejectsBadResolutions() public {
        _postDefault();
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(EpochPayoutV2.WrongState.selector, EpochPayoutV2.State.Open));
        payout.resolve(EPOCH, root, total, EVIDENCE); // not challenged
        vm.prank(watcher);
        payout.challenge(EPOCH, EVIDENCE);
        vm.startPrank(owner);
        vm.expectRevert(EpochPayoutV2.BadResolution.selector);
        payout.resolve(EPOCH, root, total + 1, EVIDENCE);          // cannot grow
        vm.expectRevert(EpochPayoutV2.BadResolution.selector);
        payout.resolve(EPOCH, bytes32(0), 5, EVIDENCE);            // void needs total 0
        vm.expectRevert(EpochPayoutV2.BadResolution.selector);
        payout.resolve(EPOCH, root, 0, EVIDENCE);                  // root needs a total
        vm.stopPrank();
    }

    function test_dismiss_ownerAnytime_anyoneAfterTimeout_noRechallenge() public {
        _postDefault();
        vm.prank(watcher);
        payout.challenge(EPOCH, EVIDENCE);
        vm.prank(stranger);
        vm.expectRevert(EpochPayoutV2.NotOwner.selector);
        payout.dismiss(EPOCH);
        vm.warp(block.timestamp + DISPUTE_TIMEOUT);
        vm.prank(stranger);
        payout.dismiss(EPOCH); // an owner that never answers cannot lock the funds
        assertTrue(_state(EPOCH) == EpochPayoutV2.State.Open);
        vm.prank(watcher);
        vm.expectRevert(EpochPayoutV2.AlreadyChallenged.selector);
        payout.challenge(EPOCH, EVIDENCE);
        _claim(0); // window is long over
        // Owner dismisses at once on another epoch.
        _post(EPOCH + 1, root, total, HCS + 1, 0);
        vm.prank(watcher);
        payout.challenge(EPOCH + 1, EVIDENCE);
        vm.prank(owner);
        payout.dismiss(EPOCH + 1);
    }

    // ---------- sweep (permissionless, to the treasury) ----------

    function test_sweep_afterDelay_toTreasury_byAnyone_once() public {
        _postDefault();
        vm.warp(block.timestamp + WINDOW);
        _claim(0);
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(EpochPayoutV2.SweepNotOpen.selector, uint64(block.timestamp - WINDOW) + SWEEP_DELAY));
        payout.sweep(EPOCH);
        vm.warp(block.timestamp + SWEEP_DELAY);
        vm.prank(stranger);
        payout.sweep(EPOCH);
        assertEq(treasury.balance, total - leaves[0].amount);
        assertEq(address(payout).balance, 0);
        vm.prank(stranger);
        vm.expectRevert(EpochPayoutV2.NothingToSweep.selector);
        payout.sweep(EPOCH);
        vm.prank(leaves[1].account);
        vm.expectRevert(EpochPayoutV2.OverClaim.selector);
        payout.claim(EPOCH, leaves[1].amount, leaves[1].proof);
    }

    function test_sweep_notWhileChallenged_vestingDelaysSweep() public {
        uint64 unlock = uint64(block.timestamp) + 3 days;
        _post(EPOCH, root, total, HCS, unlock);
        assertEq(payout.sweepOpensAt(EPOCH), unlock + SWEEP_DELAY);
        vm.prank(watcher);
        payout.challenge(EPOCH, EVIDENCE);
        vm.warp(block.timestamp + 40 days);
        vm.expectRevert(abi.encodeWithSelector(EpochPayoutV2.WrongState.selector, EpochPayoutV2.State.Challenged));
        payout.sweep(EPOCH);
    }

    // ---------- reentrancy ----------

    function test_claim_reentrancyBlocked() public {
        Reenterer2 r = new Reenterer2(payout);
        // Build a two-leaf tree: the attacker contract + leaf 1.
        uint256 amt = 5 ether;
        bytes32 leafA = keccak256(abi.encodePacked(address(r), amt));
        bytes32 leafB = leaves[1].leaf;
        bytes32 treeRoot = _pair(leafA, leafB);
        uint256 treeTotal = amt + leaves[1].amount;
        vm.deal(settler, treeTotal * 2);
        _post(EPOCH, treeRoot, treeTotal, HCS, 0);
        _post(EPOCH + 1, treeRoot, treeTotal, HCS + 1, 0);
        vm.warp(block.timestamp + WINDOW);
        bytes32[] memory pa = new bytes32[](1);
        pa[0] = leafB;
        r.arm(EPOCH + 1, amt, pa);
        vm.expectRevert(EpochPayoutV2.TransferFailed.selector);
        r.claim(EPOCH, amt, pa); // inner claim reverts Reentrancy → outer transfer fails
    }
}
