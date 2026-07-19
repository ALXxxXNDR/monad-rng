// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";

import {Deploy} from "../script/Deploy.s.sol";
import {PlatformRandomness} from "../src/PlatformRandomness.sol";
import {RandomnessFactory} from "../src/RandomnessFactory.sol";

contract DeployTest is Test {
    address private constant DEPLOYER = address(0xD3E10);
    uint256 private constant TESTNET_CHAIN_ID = 10_143;

    function setUp() public {
        vm.setEnv("DEPLOYER_ADDRESS", vm.toString(DEPLOYER));
        vm.setEnv("EXPECTED_CHAIN_ID", vm.toString(TESTNET_CHAIN_ID));
    }

    function test_DeploymentRefusesWrongChain() public {
        vm.chainId(143);
        Deploy script = new Deploy();

        vm.expectRevert(abi.encodeWithSelector(Deploy.WrongChain.selector, TESTNET_CHAIN_ID, 143));
        script.run();
    }

    function test_DeploymentCreatesOwnerlessFactoryAndFixedFreeCanaryThroughFactory() public {
        vm.chainId(TESTNET_CHAIN_ID);
        Deploy script = new Deploy();

        (RandomnessFactory factory, PlatformRandomness canary) = script.run();

        assertEq(factory.VERSION(), 1);
        assertEq(canary.VERSION(), 1);
        assertTrue(canary.CONFIGURATION_LOCKED());
        assertEq(canary.revenueRecipient(), DEPLOYER);
        assertEq(canary.platformName(), "Monad RNG Public V1");
        assertEq(canary.requestPrice(), 0);
        assertEq(canary.maxPending(), 0);
        assertEq(canary.protocolFee(), 0);
    }
}
