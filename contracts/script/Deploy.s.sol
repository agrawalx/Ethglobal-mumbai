// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {EpochPayout} from "../src/EpochPayout.sol";

/// Deploy to Hedera testnet through Hashio (chain 296). Reads contracts/.env:
///   DEPLOYER_PRIVATE_KEY (ECDSA, 0x…), SETTLER_ADDRESS, CLAIM_DELAY_SECONDS, SWEEP_DELAY_SECONDS
/// forge script script/Deploy.s.sol --rpc-url hedera_testnet --broadcast --slow
contract Deploy is Script {
    function run() external returns (EpochPayout payout) {
        uint256 pk = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address settler = vm.envAddress("SETTLER_ADDRESS");
        uint64 claimDelay = uint64(vm.envUint("CLAIM_DELAY_SECONDS"));
        uint64 sweepDelay = uint64(vm.envUint("SWEEP_DELAY_SECONDS"));
        require(block.chainid == 296, "not Hedera testnet (296)");

        vm.startBroadcast(pk);
        payout = new EpochPayout(settler, claimDelay, sweepDelay);
        vm.stopBroadcast();
        console.log("EpochPayout", address(payout));
        console.log("settler", settler);
    }
}
