// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script} from "forge-std/Script.sol";

import {RandomnessFactory} from "../src/RandomnessFactory.sol";

/// @notice Optional factory deployment. The caller supplies and funds its own local key.
contract Deploy is Script {
    function run() external returns (RandomnessFactory factory) {
        uint256 deployerPrivateKey = vm.envUint("DEPLOYER_PRIVATE_KEY");

        vm.startBroadcast(deployerPrivateKey);
        factory = new RandomnessFactory();
        vm.stopBroadcast();
    }
}
