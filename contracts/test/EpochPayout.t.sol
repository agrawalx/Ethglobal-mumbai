// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {EpochPayout} from "../src/EpochPayout.sol";

/// Claims a second epoch from inside receive(): must hit the reentrancy guard.
contract Reenterer {
    EpochPayout public target;
    uint64 public epoch2;
    uint256 public amount2;
    bytes32[] public proof2;
    bool public tried;

    constructor(EpochPayout t) {
        target = t;
    }

    function arm(uint64 e, uint256 a, bytes32[] calldata p) external {
        epoch2 = e;
        amount2 = a;
        proof2 = p;
    }

    function claim(uint64 e, uint256 a, bytes32[] calldata p) external {
        target.claim(e, a, p);
    }

    receive() external payable {
        if (tried) return;
        tried = true;
        target.claim(epoch2, amount2, proof2); // reverts with Reentrancy → the outer transfer fails
    }
}

contract EpochPayoutTest is Test {
    EpochPayout payout;
    address settler = makeAddr("settler");
    uint64 constant CLAIM_DELAY = 60;
    uint64 constant SWEEP_DELAY = 7 days;
    uint64 constant EPOCH = 2989853;

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
        payout = new EpochPayout(settler, CLAIM_DELAY, SWEEP_DELAY);
        vm.deal(settler, 100 ether);
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

    function _post(uint64 epoch, bytes32 r, uint256 value) internal {
        vm.prank(settler);
        payout.postEpoch{value: value}(epoch, r);
    }

    function _claim(Leaf storage l) internal {
        vm.prank(l.account);
        payout.claim(EPOCH, l.amount, l.proof);
    }

    // ---------- cross-language vector ----------

    function test_vector_leafHashesMatchSolidityEncoding() public view {
        for (uint256 i = 0; i < 3; i++) {
            assertEq(keccak256(abi.encodePacked(leaves[i].account, leaves[i].amount)), leaves[i].leaf);
            assertTrue(payout.verify(leaves[i].proof, root, leaves[i].leaf));
        }
    }

    // ---------- post ----------

    function test_post_storesEpoch() public {
        vm.expectEmit(true, false, false, true);
        emit EpochPayout.EpochPosted(EPOCH, root, total);
        _post(EPOCH, root, total);
        (bytes32 r, uint256 t, uint256 c, uint64 at) = payout.epochs(EPOCH);
        assertEq(r, root);
        assertEq(t, total);
        assertEq(c, 0);
        assertEq(at, block.timestamp);
        assertEq(address(payout).balance, total);
    }

    function test_post_onlySettler() public {
        vm.deal(address(this), total);
        vm.expectRevert(EpochPayout.NotSettler.selector);
        payout.postEpoch{value: total}(EPOCH, root);
    }

    function test_post_rejectsRepost() public {
        _post(EPOCH, root, total);
        vm.prank(settler);
        vm.expectRevert(abi.encodeWithSelector(EpochPayout.EpochAlreadyPosted.selector, EPOCH));
        payout.postEpoch{value: total}(EPOCH, root);
    }

    function test_post_rejectsZeroRootAndZeroValue() public {
        vm.startPrank(settler);
        vm.expectRevert(EpochPayout.ZeroRoot.selector);
        payout.postEpoch{value: total}(EPOCH, bytes32(0));
        vm.expectRevert(EpochPayout.ZeroTotal.selector);
        payout.postEpoch(EPOCH, root);
        vm.stopPrank();
    }

    // ---------- claim ----------

    function test_claim_multiLeaf_allProvidersPaid() public {
        _post(EPOCH, root, total);
        vm.warp(block.timestamp + CLAIM_DELAY);
        for (uint256 i = 0; i < 3; i++) {
            uint256 before = leaves[i].account.balance;
            vm.expectEmit(true, true, false, true);
            emit EpochPayout.Claimed(EPOCH, leaves[i].account, leaves[i].amount);
            _claim(leaves[i]);
            assertEq(leaves[i].account.balance - before, leaves[i].amount);
            assertTrue(payout.hasClaimed(EPOCH, leaves[i].account));
        }
        (,, uint256 claimed,) = payout.epochs(EPOCH);
        assertEq(claimed, total);
        assertEq(address(payout).balance, 0);
    }

    function test_claim_singleLeaf_emptyProof() public {
        string memory json = vm.readFile("test/fixtures/merkle-vector.json");
        address a = vm.parseJsonAddress(json, ".single.payout_address");
        uint256 amt = vm.parseUint(vm.parseJsonString(json, ".single.amount_tinybar"));
        bytes32 r = vm.parseJsonBytes32(json, ".single.root");
        assertEq(r, keccak256(abi.encodePacked(a, amt)));
        _post(EPOCH, r, amt);
        vm.warp(block.timestamp + CLAIM_DELAY);
        vm.prank(a);
        payout.claim(EPOCH, amt, new bytes32[](0));
        assertEq(a.balance, amt);
    }

    function test_claim_doubleClaimReverts() public {
        _post(EPOCH, root, total);
        vm.warp(block.timestamp + CLAIM_DELAY);
        _claim(leaves[0]);
        vm.prank(leaves[0].account);
        vm.expectRevert(EpochPayout.AlreadyClaimed.selector);
        payout.claim(EPOCH, leaves[0].amount, leaves[0].proof);
    }

    function test_claim_badProofReverts() public {
        _post(EPOCH, root, total);
        vm.warp(block.timestamp + CLAIM_DELAY);
        vm.prank(leaves[0].account);
        vm.expectRevert(EpochPayout.InvalidProof.selector);
        payout.claim(EPOCH, leaves[0].amount, leaves[1].proof);
    }

    function test_claim_wrongAmountReverts() public {
        _post(EPOCH, root, total);
        vm.warp(block.timestamp + CLAIM_DELAY);
        vm.prank(leaves[0].account);
        vm.expectRevert(EpochPayout.InvalidProof.selector);
        payout.claim(EPOCH, leaves[0].amount + 1, leaves[0].proof);
    }

    function test_claim_wrongSenderReverts() public {
        _post(EPOCH, root, total);
        vm.warp(block.timestamp + CLAIM_DELAY);
        vm.prank(makeAddr("thief"));
        vm.expectRevert(EpochPayout.InvalidProof.selector);
        payout.claim(EPOCH, leaves[0].amount, leaves[0].proof);
    }

    function test_claim_beforeDelayReverts() public {
        _post(EPOCH, root, total);
        vm.warp(block.timestamp + CLAIM_DELAY - 1);
        vm.prank(leaves[0].account);
        vm.expectRevert(abi.encodeWithSelector(EpochPayout.ClaimNotOpen.selector, uint64(block.timestamp + 1)));
        payout.claim(EPOCH, leaves[0].amount, leaves[0].proof);
    }

    function test_claim_unpostedEpochReverts() public {
        vm.prank(leaves[0].account);
        vm.expectRevert(abi.encodeWithSelector(EpochPayout.EpochNotPosted.selector, EPOCH));
        payout.claim(EPOCH, leaves[0].amount, leaves[0].proof);
    }

    function test_claim_overClaimReverts() public {
        // Settler under-funds the epoch: the tree sums to `total` but only total-1 was sent.
        _post(EPOCH, root, total - 1);
        vm.warp(block.timestamp + CLAIM_DELAY);
        _claim(leaves[0]);
        _claim(leaves[1]);
        vm.prank(leaves[2].account);
        vm.expectRevert(EpochPayout.OverClaim.selector);
        payout.claim(EPOCH, leaves[2].amount, leaves[2].proof);
    }

    function test_claim_reentrancyBlocked() public {
        // Two epochs whose single leaf is the attacker contract.
        Reenterer bad = new Reenterer(payout);
        uint256 amt = 1_000_000;
        bytes32 leaf = keccak256(abi.encodePacked(address(bad), amt));
        _post(1, leaf, amt);
        _post(2, leaf, amt);
        vm.warp(block.timestamp + CLAIM_DELAY);
        bad.arm(2, amt, new bytes32[](0));
        vm.expectRevert(EpochPayout.TransferFailed.selector);
        bad.claim(1, amt, new bytes32[](0));
        assertEq(address(payout).balance, 2 * amt);
        assertFalse(payout.hasClaimed(1, address(bad)));
        assertFalse(payout.hasClaimed(2, address(bad)));
    }

    // ---------- sweep ----------

    function test_sweep_onlySettlerAfterDelay() public {
        _post(EPOCH, root, total);
        vm.warp(block.timestamp + CLAIM_DELAY);
        _claim(leaves[0]);

        vm.expectRevert(EpochPayout.NotSettler.selector);
        payout.sweep(EPOCH);

        vm.prank(settler);
        vm.expectRevert();
        payout.sweep(EPOCH); // before sweepDelay

        vm.warp(block.timestamp + SWEEP_DELAY);
        uint256 before = settler.balance;
        vm.expectEmit(true, false, false, true);
        emit EpochPayout.Swept(EPOCH, total - leaves[0].amount);
        vm.prank(settler);
        payout.sweep(EPOCH);
        assertEq(settler.balance - before, total - leaves[0].amount);
        assertEq(address(payout).balance, 0);

        // No claims and no second sweep afterwards.
        vm.prank(leaves[1].account);
        vm.expectRevert(EpochPayout.OverClaim.selector);
        payout.claim(EPOCH, leaves[1].amount, leaves[1].proof);
        vm.prank(settler);
        vm.expectRevert(EpochPayout.NothingToSweep.selector);
        payout.sweep(EPOCH);
    }

    // ---------- units ----------

    /// Hedera gotcha: inside the EVM, msg.value and address.balance are TINYBARS (8 decimals).
    /// JSON-RPC (Hashio, ethers, cast) shows WEIBARS (18 decimals): a JSON-RPC tx `value` of
    /// `total × 10^10` weibars arrives in the contract as `total` tinybars. The contract does no
    /// conversion: leaf amounts, the epoch total, msg.value and payouts are all the same unit.
    /// The settlement job must send value = total_tinybar × 10^10 through JSON-RPC.
    function test_units_tinybarsInTinybarsOut() public {
        uint256 oneHbar = 1e8; // tinybars
        uint256 a = 6 * oneHbar / 100; // 0.06 HBAR = 6_000_000 tinybar (SPEC §7.3, 14B tier 2)
        address p = makeAddr("provider");
        bytes32 leaf = keccak256(abi.encodePacked(p, a));
        _post(EPOCH, leaf, a);
        (, uint256 t,,) = payout.epochs(EPOCH);
        assertEq(t, 6_000_000, "total is stored in the same unit as msg.value (tinybar)");
        vm.warp(block.timestamp + CLAIM_DELAY);
        vm.prank(p);
        payout.claim(EPOCH, a, new bytes32[](0));
        assertEq(p.balance, 6_000_000, "payout equals the leaf amount, no scaling");
        // The JSON-RPC value the settlement job sends for this epoch:
        assertEq(t * 1e10, 0.06 ether, "weibar value = tinybar total x 10^10");
    }
}
