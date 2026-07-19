// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {Vm} from "forge-std/Vm.sol";

import {PlatformRandomness} from "../src/PlatformRandomness.sol";
import {RandomnessFactory} from "../src/RandomnessFactory.sol";

contract RandomnessFactoryTest is Test {
    bytes32 private constant PLATFORM_DEPLOYED_TOPIC =
        keccak256("PlatformDeployed(address,address,string,uint256,uint256)");

    address private alice = makeAddr("alice");
    address private bob = makeAddr("bob");

    RandomnessFactory private factory;

    function setUp() public {
        factory = new RandomnessFactory();
        vm.deal(alice, 20 ether);
        vm.deal(bob, 20 ether);
    }

    function test_DeployPlatformCreatesOwnerlessFixedRecipientInstanceAndEmitsDiscoveryEvent() public {
        vm.recordLogs();
        vm.prank(alice);
        PlatformRandomness platform = factory.deployPlatform(bob, "Demo", 0, 128);
        Vm.Log[] memory entries = vm.getRecordedLogs();

        assertEq(platform.revenueRecipient(), bob);
        assertEq(platform.platformName(), "Demo");
        assertEq(platform.requestPrice(), 0);
        assertEq(platform.maxPending(), 128);
        assertEq(platform.protocolFee(), 0);
        assertEq(platform.VERSION(), 1);
        assertTrue(platform.CONFIGURATION_LOCKED());
        assertGt(address(platform).code.length, 0);

        uint256 deploymentEvents;
        for (uint256 index; index < entries.length; ++index) {
            Vm.Log memory entry = entries[index];
            if (entry.emitter != address(factory) || entry.topics[0] != PLATFORM_DEPLOYED_TOPIC) {
                continue;
            }

            ++deploymentEvents;
            assertEq(address(uint160(uint256(entry.topics[1]))), address(platform));
            assertEq(address(uint160(uint256(entry.topics[2]))), bob);
            (string memory name, uint256 price, uint256 cap) = abi.decode(entry.data, (string, uint256, uint256));
            assertEq(name, "Demo");
            assertEq(price, 0);
            assertEq(cap, 128);
        }
        assertEq(deploymentEvents, 1);
    }

    function test_DeployedPlatformsIsolateCountersFundsAndPendingCaps() public {
        vm.startPrank(alice);
        PlatformRandomness platformA = factory.deployPlatform(alice, "Platform A", 1 ether, 1);
        PlatformRandomness platformB = factory.deployPlatform(bob, "Platform B", 2 ether, 2);

        uint256 aFirst = platformA.requestRandomness{value: 1 ether}();
        uint256 bFirst = platformB.requestRandomness{value: 2 ether}();
        uint256 bSecond = platformB.requestRandomness{value: 2 ether}();

        vm.expectRevert(PlatformRandomness.PendingLimitReached.selector);
        platformA.requestRandomness{value: 1 ether}();
        vm.stopPrank();

        assertEq(aFirst, 1);
        assertEq(bFirst, 1);
        assertEq(bSecond, 2);
        assertEq(platformA.nextRequestId(), 2);
        assertEq(platformB.nextRequestId(), 3);
        assertEq(platformA.pendingCount(), 1);
        assertEq(platformB.pendingCount(), 2);
        assertEq(platformA.maxPending(), 1);
        assertEq(platformB.maxPending(), 2);
        assertEq(address(platformA).balance, 1 ether);
        assertEq(address(platformB).balance, 4 ether);
        assertEq(address(factory).balance, 0);
    }

    function test_FactoryIsStatelessOwnerlessAndHasNoAdminPaths() public {
        assertEq(vm.load(address(factory), bytes32(0)), bytes32(0));
        _assertMissing(abi.encodeWithSignature("owner()"));
        _assertMissing(abi.encodeWithSignature("treasury()"));
        _assertMissing(abi.encodeWithSignature("platformCount()"));
        _assertMissing(abi.encodeWithSignature("platforms(uint256)", 0));
        _assertMissing(abi.encodeWithSignature("withdraw(address,uint256)", alice, 1));
        _assertMissing(abi.encodeWithSignature("upgradeTo(address)", bob));
        _assertMissing(abi.encodeWithSignature("transferOwnership(address)", bob));
        assertEq(factory.VERSION(), 1);
    }

    function test_FactoryDeploymentPathIsNonpayableAndRetainsNoMon() public {
        bytes memory callData = abi.encodeWithSelector(RandomnessFactory.deployPlatform.selector, alice, "Demo", 0, 128);

        vm.prank(alice);
        (bool success,) = address(factory).call{value: 1 wei}(callData);

        assertFalse(success);
        assertEq(address(factory).balance, 0);
    }

    function _assertMissing(bytes memory callData) private {
        (bool success, bytes memory returnData) = address(factory).call(callData);
        assertFalse(success);
        assertEq(returnData.length, 0);
    }
}
