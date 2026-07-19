// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {StdInvariant} from "forge-std/StdInvariant.sol";
import {Test} from "forge-std/Test.sol";

import {PlatformRandomness} from "../src/PlatformRandomness.sol";

contract PlatformRandomnessHandler is Test {
    address private constant HISTORY_STORAGE = 0x0000F90827F1C53a10cb7A02335B175320002935;
    address private constant ALICE = address(0xA11CE);
    address private constant BOB = address(0xB0B);
    address private constant CAROL = address(0xCA401);

    PlatformRandomness public immutable PLATFORM;

    uint256 public totalRequests;
    uint256 public ghostPending;
    uint256 public successfulFinalizations;
    uint256 public successfulExpirations;
    uint256 public recentFinalizations;
    uint256 public historicalFinalizations;

    constructor(PlatformRandomness platform_) {
        PLATFORM = platform_;
    }

    function request(uint256 actorSeed) external {
        _request(_actor(actorSeed));
    }

    function finalizeRecent(uint256 actorSeed, uint256 entropySeed) external {
        address requester = _actor(actorSeed);
        (uint256 requestId, PlatformRandomness.Request memory request_) = _request(requester);
        (bytes memory header1, bytes memory header2, bytes memory header3) = _headers(request_, requestId, entropySeed);

        vm.roll(request_.thirdTargetBlock + 2);
        vm.setBlockhash(request_.firstTargetBlock, keccak256(header1));
        vm.setBlockhash(request_.secondTargetBlock, keccak256(header2));
        vm.setBlockhash(request_.thirdTargetBlock, keccak256(header3));

        vm.prank(requester);
        PLATFORM.finalizeRandomness(requestId, header1, header2, header3);

        --ghostPending;
        ++successfulFinalizations;
        ++recentFinalizations;
    }

    function finalizeHistorical(uint256 actorSeed, uint256 callerSeed, uint256 entropySeed) external {
        address requester = _actor(actorSeed);
        (uint256 requestId, PlatformRandomness.Request memory request_) = _request(requester);
        (bytes memory header1, bytes memory header2, bytes memory header3) = _headers(request_, requestId, entropySeed);

        // All three target blocks are older than the EVM's 256-block BLOCKHASH
        // window here, so the contract must authenticate them through EIP-2935.
        vm.roll(request_.thirdTargetBlock + 300);
        _mockHistoricalHash(request_.firstTargetBlock, keccak256(header1));
        _mockHistoricalHash(request_.secondTargetBlock, keccak256(header2));
        _mockHistoricalHash(request_.thirdTargetBlock, keccak256(header3));

        vm.prank(_actor(callerSeed));
        PLATFORM.finalizeRandomness(requestId, header1, header2, header3);

        --ghostPending;
        ++successfulFinalizations;
        ++historicalFinalizations;
    }

    function expire(uint256 requesterSeed, uint256 expirerSeed) external {
        (uint256 requestId, PlatformRandomness.Request memory request_) = _request(_actor(requesterSeed));

        vm.roll(request_.firstTargetBlock + 8_192);
        vm.prank(_actor(expirerSeed));
        PLATFORM.expireRequest(requestId);

        --ghostPending;
        ++successfulExpirations;
    }

    function _request(address requester)
        private
        returns (uint256 requestId, PlatformRandomness.Request memory request_)
    {
        vm.prank(requester);
        requestId = PLATFORM.requestRandomness();

        ++totalRequests;
        ++ghostPending;
        assertEq(requestId, totalRequests);
        request_ = PLATFORM.getRequest(requestId);
    }

    function _headers(PlatformRandomness.Request memory request_, uint256 requestId, uint256 entropySeed)
        private
        pure
        returns (bytes memory header1, bytes memory header2, bytes memory header3)
    {
        header1 = _minimalHeader(
            request_.firstTargetBlock, keccak256(abi.encode("INVARIANT_MIX_1", requestId, entropySeed))
        );
        header2 = _minimalHeader(
            request_.secondTargetBlock, keccak256(abi.encode("INVARIANT_MIX_2", requestId, entropySeed))
        );
        header3 =
            _minimalHeader(request_.thirdTargetBlock, keccak256(abi.encode("INVARIANT_MIX_3", requestId, entropySeed)));
    }

    function _minimalHeader(uint256 blockNumber, bytes32 mixHash) private pure returns (bytes memory header) {
        bytes memory encodedBlockNumber = _rlpUint(blockNumber);
        bytes memory payload = abi.encodePacked(
            hex"8080808080808080", // fields 0 through 7
            encodedBlockNumber, // field 8: block number
            hex"80808080a0", // fields 9 through 12, then a 32-byte field 13
            mixHash
        );
        require(payload.length < 56, "fixture payload too long");

        // The preceding bound proves this fixture-only narrowing conversion is safe.
        // forge-lint: disable-next-line(unsafe-typecast)
        header = abi.encodePacked(bytes1(uint8(0xc0 + payload.length)), payload);
    }

    function _rlpUint(uint256 value) private pure returns (bytes memory encoded) {
        if (value == 0) {
            return hex"80";
        }
        if (value <= 0x7f) {
            // The branch proves this fixture-only narrowing conversion is safe.
            // forge-lint: disable-next-line(unsafe-typecast)
            return abi.encodePacked(bytes1(uint8(value)));
        }
        if (value <= type(uint8).max) {
            // The branch proves this fixture-only narrowing conversion is safe.
            // forge-lint: disable-next-line(unsafe-typecast)
            return abi.encodePacked(hex"81", bytes1(uint8(value)));
        }
        if (value <= type(uint16).max) {
            // The branch proves this fixture-only narrowing conversion is safe.
            // forge-lint: disable-next-line(unsafe-typecast)
            return abi.encodePacked(hex"82", bytes2(uint16(value)));
        }
        if (value <= type(uint24).max) {
            // The branch proves this fixture-only narrowing conversion is safe.
            // forge-lint: disable-next-line(unsafe-typecast)
            return abi.encodePacked(hex"83", bytes3(uint24(value)));
        }
        require(value <= type(uint32).max, "fixture block exceeds uint32");
        // The preceding bound proves this fixture-only narrowing conversion is safe.
        // forge-lint: disable-next-line(unsafe-typecast)
        return abi.encodePacked(hex"84", bytes4(uint32(value)));
    }

    function _mockHistoricalHash(uint256 blockNumber, bytes32 blockHash) private {
        vm.mockCall(HISTORY_STORAGE, abi.encode(blockNumber), abi.encode(blockHash));
    }

    function _actor(uint256 seed) private pure returns (address) {
        uint256 actorIndex = seed % 3;
        if (actorIndex == 0) {
            return ALICE;
        }
        if (actorIndex == 1) {
            return BOB;
        }
        return CAROL;
    }
}

contract PlatformRandomnessInvariantTest is StdInvariant, Test {
    address private constant REVENUE_RECIPIENT = address(0xBEEF);
    string private constant PLATFORM_NAME = "Invariant platform";

    PlatformRandomness private platform;
    PlatformRandomnessHandler private handler;

    function setUp() public {
        platform = new PlatformRandomness(REVENUE_RECIPIENT, PLATFORM_NAME, 0, 0);
        handler = new PlatformRandomnessHandler(platform);

        // Seed every meaningful state transition once so every invariant run
        // starts with proof that request, both finalize paths, and expiry work.
        handler.request(0);
        handler.finalizeRecent(1, 11);
        handler.finalizeHistorical(2, 0, 22);
        handler.expire(0, 1);

        bytes4[] memory selectors = new bytes4[](4);
        selectors[0] = PlatformRandomnessHandler.request.selector;
        selectors[1] = PlatformRandomnessHandler.finalizeRecent.selector;
        selectors[2] = PlatformRandomnessHandler.finalizeHistorical.selector;
        selectors[3] = PlatformRandomnessHandler.expire.selector;
        targetContract(address(handler));
        targetSelector(FuzzSelector({addr: address(handler), selectors: selectors}));
    }

    function invariant_ConfigurationNeverChanges() public view {
        assertEq(platform.revenueRecipient(), REVENUE_RECIPIENT);
        assertEq(platform.platformName(), PLATFORM_NAME);
        assertEq(platform.requestPrice(), 0);
        assertEq(platform.maxPending(), 0);
        assertEq(platform.VERSION(), 1);
        assertTrue(platform.CONFIGURATION_LOCKED());
        assertEq(platform.protocolFee(), 0);
    }

    function invariant_RequestCountersRemainConsistent() public view {
        uint256 totalRequests = handler.totalRequests();
        uint256 finalized = handler.successfulFinalizations();
        uint256 expired = handler.successfulExpirations();
        uint256 pending = handler.ghostPending();

        assertEq(platform.nextRequestId(), totalRequests + 1);
        assertEq(platform.pendingCount(), pending);
        assertEq(totalRequests, pending + finalized + expired);
        assertGe(platform.nextRequestId(), 1);
    }

    function invariant_AllLifecycleBranchesExecuteSuccessfully() public view {
        assertGt(handler.recentFinalizations(), 0);
        assertGt(handler.historicalFinalizations(), 0);
        assertGt(handler.successfulExpirations(), 0);
    }
}
