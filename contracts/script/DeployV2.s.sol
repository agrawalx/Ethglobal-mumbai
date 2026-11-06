// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {EpochPayoutV2} from "../src/EpochPayoutV2.sol";

/// Deploy EpochPayoutV2 to Hedera testnet through Hashio (chain 296). Reads contracts/.env:
///   DEPLOYER_PRIVATE_KEY (ECDSA, 0x…), OWNER_ADDRESS (resolves disputes; default: deployer),
///   TREASURY_ADDRESS (receives swept and clawed-back value), SETTLER_ADDRESS, GATEWAY_INDEX (default 0),
///   CHALLENGE_WINDOW_SECONDS, DISPUTE_TIMEOUT_SECONDS, SWEEP_DELAY_SECONDS, MAX_VESTING_SECONDS,
///   MAX_EPOCH_TOTAL_TINYBAR (0 = no cap)
/// forge script script/DeployV2.s.sol --rpc-url hedera_testnet --broadcast --slow
contract DeployV2 is Script {
    function run() external returns (EpochPayoutV2 payout) {
        uint256 pk = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address owner = vm.envOr("OWNER_ADDRESS", vm.addr(pk));
        address treasury = vm.envAddress("TREASURY_ADDRESS");
        address settler = vm.envAddress("SETTLER_ADDRESS");
        uint32 gatewayIndex = uint32(vm.envOr("GATEWAY_INDEX", uint256(0)));
        require(block.chainid == 296, "not Hedera testnet (296)");

        vm.startBroadcast(pk);
        payout = new EpochPayoutV2(
            owner,
            treasury,
            settler,
            gatewayIndex,
            uint64(vm.envUint("CHALLENGE_WINDOW_SECONDS")),
            uint64(vm.envUint("DISPUTE_TIMEOUT_SECONDS")),
            uint64(vm.envUint("SWEEP_DELAY_SECONDS")),
            uint64(vm.envUint("MAX_VESTING_SECONDS")),
            vm.envOr("MAX_EPOCH_TOTAL_TINYBAR", uint256(0))
        );
        vm.stopBroadcast();
        console.log("EpochPayoutV2", address(payout));
        console.log("owner", owner);
        console.log("settler", settler);
    }
}
