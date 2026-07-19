// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script} from "forge-std/Script.sol";

import {PlatformRandomness} from "../src/PlatformRandomness.sol";
import {RandomnessFactory} from "../src/RandomnessFactory.sol";

/// @notice Deploys the ownerless Factory and a free, uncapped public V1 canary.
/// The deployment account is only the fixed recipient for the zero-priced
/// canary. It receives no owner, admin, pause, or upgrade authority.
contract Deploy is Script {
    error WrongChain(uint256 expected, uint256 actual);

    string internal constant CANARY_NAME = "Monad RNG Public V1";
    uint256 internal constant CANARY_REQUEST_PRICE = 0;
    uint256 internal constant CANARY_MAX_PENDING = 0;

    function run() external returns (RandomnessFactory factory, PlatformRandomness canary) {
        address deployer = vm.envAddress("DEPLOYER_ADDRESS");
        uint256 expectedChainId = vm.envUint("EXPECTED_CHAIN_ID");
        if (block.chainid != expectedChainId) {
            revert WrongChain(expectedChainId, block.chainid);
        }

        vm.startBroadcast(deployer);
        factory = new RandomnessFactory();
        canary = factory.deployPlatform(deployer, CANARY_NAME, CANARY_REQUEST_PRICE, CANARY_MAX_PENDING);
        vm.stopBroadcast();
    }
}
