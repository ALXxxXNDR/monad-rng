// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";

import {PlatformRandomness} from "../src/PlatformRandomness.sol";
import {MonadHeaderFixture} from "./fixtures/MonadHeaderFixture.sol";

contract ReentrantRevenueRecipient {
    PlatformRandomness public randomness;

    bool public attemptedReentry;
    bool public reentrySucceeded;

    constructor() {
        randomness = new PlatformRandomness(address(this), "Reentry Harness", 1 ether, 1);
    }

    receive() external payable {
        attemptedReentry = true;
        try randomness.withdrawRevenue() {
            reentrySucceeded = true;
        } catch {}
    }
}

contract ToggleRevenueRecipient {
    PlatformRandomness public randomness;
    bool public rejectsRevenue = true;

    constructor() {
        randomness = new PlatformRandomness(address(this), "Toggle Harness", 1 ether, 1);
    }

    function allowRevenue() external {
        rejectsRevenue = false;
    }

    receive() external payable {
        require(!rejectsRevenue, "revenue rejected");
    }
}

contract PlatformRandomnessDrawHarness is PlatformRandomness {
    constructor() PlatformRandomness(address(this), "Draw Harness", 0, 1) {}

    function exposedDraw(bytes32 seed, uint256 upperBound) external pure returns (uint256) {
        return _draw(seed, upperBound);
    }
}

contract PlatformRandomnessTest is Test {
    address private constant HISTORY_STORAGE = 0x0000F90827F1C53a10cb7A02335B175320002935;
    uint256 private constant FIXTURE_BLOCK = 45_730_415;
    uint256 private constant REQUEST_BLOCK = FIXTURE_BLOCK - 8;
    bytes32 private constant FIXTURE_MIX_HASH = 0x03ff4794124a285d6f8024f7620315ccf5233c1e252bb7843e45e3a06ff604e9;
    bytes32 private constant MIX_HASH_ONE = bytes32(uint256(0x1111));
    bytes32 private constant MIX_HASH_TWO = bytes32(uint256(0x2222));
    bytes32 private constant MIX_HASH_THREE = bytes32(uint256(0x3333));

    event RandomnessRequested(
        uint256 indexed requestId,
        address indexed requester,
        uint256 requestBlock,
        uint256 firstTargetBlock,
        uint256 secondTargetBlock,
        uint256 thirdTargetBlock,
        uint256 pricePaid
    );
    event RandomnessFinalized(
        uint256 indexed requestId, address indexed requester, address indexed finalizer, bytes32 result
    );
    event RandomnessRequestExpired(uint256 indexed requestId, address indexed requester, address indexed expirer);
    event RevenueWithdrawn(address indexed caller, address indexed recipient, uint256 amount);

    address private recipientA = makeAddr("recipientA");
    address private recipientB = makeAddr("recipientB");
    address private alice = makeAddr("alice");
    address private bob = makeAddr("bob");

    PlatformRandomness private platformA;
    PlatformRandomness private platformB;
    PlatformRandomnessDrawHarness private drawHarness;

    function setUp() public {
        platformA = new PlatformRandomness(recipientA, "Platform A", 1 ether, 2);
        platformB = new PlatformRandomness(recipientB, "Platform B", 0, 3);
        drawHarness = new PlatformRandomnessDrawHarness();

        vm.deal(alice, 20 ether);
        vm.deal(bob, 20 ether);
        vm.roll(1_000);
    }

    function test_RequestRequiresExactPriceAndSnapshotsAllTargets() public {
        vm.expectRevert(abi.encodeWithSelector(PlatformRandomness.IncorrectPayment.selector, 1 ether, 0.9 ether));
        vm.prank(alice);
        platformA.requestRandomness{value: 0.9 ether}();

        vm.expectRevert(abi.encodeWithSelector(PlatformRandomness.IncorrectPayment.selector, 1 ether, 1.1 ether));
        vm.prank(alice);
        platformA.requestRandomness{value: 1.1 ether}();

        vm.expectEmit(true, true, false, true, address(platformA));
        emit RandomnessRequested(1, alice, 1_000, 1_008, 1_024, 1_040, 1 ether);
        vm.prank(alice);
        uint256 requestId = platformA.requestRandomness{value: 1 ether}();

        PlatformRandomness.Request memory request = platformA.getRequest(requestId);
        assertEq(requestId, 1);
        assertEq(request.requester, alice);
        assertEq(request.requestBlock, 1_000);
        assertEq(request.firstTargetBlock, 1_008);
        assertEq(request.secondTargetBlock, 1_024);
        assertEq(request.thirdTargetBlock, 1_040);
        assertEq(request.pricePaid, 1 ether);
        assertFalse(request.finalized);
        assertFalse(request.expired);
        assertEq(request.result, bytes32(0));
        assertEq(request.finalizer, address(0));
        assertEq(platformA.pendingCount(), 1);
        assertEq(platformA.nextRequestId(), 2);
        assertEq(address(platformA).balance, 1 ether);
        assertEq(platformA.platformName(), "Platform A");
    }

    function test_RequestStoresEachRequestInExactlyThreeStorageSlots() public {
        vm.prank(alice);
        platformA.requestRandomness{value: 1 ether}();

        bytes32 firstRequestSlot = keccak256(abi.encode(uint256(1), uint256(6)));
        bytes32 slot0 = vm.load(address(platformA), firstRequestSlot);
        bytes32 slot1 = vm.load(address(platformA), bytes32(uint256(firstRequestSlot) + 1));
        bytes32 slot2 = vm.load(address(platformA), bytes32(uint256(firstRequestSlot) + 2));
        bytes32 slot3 = vm.load(address(platformA), bytes32(uint256(firstRequestSlot) + 3));

        assertEq(address(uint160(uint256(slot0))), alice);
        assertEq(uint64(uint256(slot0) >> 160), uint64(1_000));
        assertEq(uint8(uint256(slot0) >> 224), 1, "pending status is packed into slot 0");
        assertEq(address(uint160(uint256(slot1))), address(0));
        assertEq(uint96(uint256(slot1) >> 160), uint96(1 ether));
        assertEq(slot2, bytes32(0), "result owns request slot 2");
        assertEq(slot3, bytes32(0), "a request must not allocate a fourth slot");
    }

    function test_RequestRejectsBlockNumberThatCannotFitCompressedSnapshot() public {
        uint256 tooLarge = uint256(type(uint64).max) - 39;
        vm.roll(tooLarge);

        vm.expectRevert(abi.encodeWithSelector(PlatformRandomness.BlockNumberTooLarge.selector, tooLarge));
        vm.prank(alice);
        platformA.requestRandomness{value: 1 ether}();
    }

    function test_RequestRejectsPriceThatCannotFitCompressedSnapshot() public {
        uint256 tooLarge = uint256(type(uint96).max) + 1;

        vm.expectRevert(abi.encodeWithSelector(PlatformRandomness.PriceTooLarge.selector, tooLarge));
        new PlatformRandomness(recipientA, "Expensive", tooLarge, 1);
    }

    function test_RequestAcceptsLargestPriceThatFitsCompressedSnapshot() public {
        uint256 largest = type(uint96).max;
        PlatformRandomness expensive = new PlatformRandomness(recipientA, "Expensive", largest, 1);
        vm.deal(alice, largest);

        vm.prank(alice);
        uint256 requestId = expensive.requestRandomness{value: largest}();

        assertEq(expensive.getRequest(requestId).pricePaid, largest);
    }

    function test_RequestCanBeFreeWhileCallerStillSubmitsOwnTransaction() public {
        vm.prank(alice);
        uint256 requestId = platformB.requestRandomness();

        PlatformRandomness.Request memory request = platformB.getRequest(requestId);
        assertEq(requestId, 1);
        assertEq(request.pricePaid, 0);
        assertEq(address(platformB).balance, 0);
        assertEq(platformB.pendingCount(), 1);

        vm.expectRevert(abi.encodeWithSelector(PlatformRandomness.IncorrectPayment.selector, 0, 1));
        vm.prank(bob);
        platformB.requestRandomness{value: 1}();
    }

    function test_RequestConfigurationIsPermanentlyFixed() public {
        vm.prank(alice);
        uint256 firstId = platformA.requestRandomness{value: 1 ether}();

        vm.roll(1_100);
        vm.prank(bob);
        uint256 secondId = platformA.requestRandomness{value: 1 ether}();

        assertEq(platformA.getRequest(firstId).pricePaid, 1 ether);
        assertEq(platformA.getRequest(secondId).pricePaid, 1 ether);
        assertEq(platformA.getRequest(firstId).firstTargetBlock, 1_008);
        assertEq(platformA.getRequest(secondId).firstTargetBlock, 1_108);
        assertEq(platformA.revenueRecipient(), recipientA);
        assertEq(platformA.platformName(), "Platform A");
        assertEq(platformA.requestPrice(), 1 ether);
        assertEq(platformA.maxPending(), 2);
        assertEq(platformA.VERSION(), 1);
        assertTrue(platformA.CONFIGURATION_LOCKED());
    }

    function test_RequestCountersAndPendingCapsAreIsolatedByPlatform() public {
        vm.prank(alice);
        uint256 aFirst = platformA.requestRandomness{value: 1 ether}();
        vm.prank(bob);
        uint256 aSecond = platformA.requestRandomness{value: 1 ether}();

        vm.expectRevert(PlatformRandomness.PendingLimitReached.selector);
        vm.prank(alice);
        platformA.requestRandomness{value: 1 ether}();

        vm.prank(alice);
        uint256 bFirst = platformB.requestRandomness();

        assertEq(aFirst, 1);
        assertEq(aSecond, 2);
        assertEq(bFirst, 1);
        assertEq(platformA.pendingCount(), 2);
        assertEq(platformB.pendingCount(), 1);
        assertEq(platformA.nextRequestId(), 3);
        assertEq(platformB.nextRequestId(), 2);
    }

    function test_RequestHasNoOwnerAdminPauseOrUpgradePaths() public {
        _assertMissing(abi.encodeWithSignature("owner()"));
        _assertMissing(abi.encodeWithSignature("setRequestPrice(uint256)", 9 ether));
        _assertMissing(abi.encodeWithSignature("setMaxPending(uint256)", 99));
        _assertMissing(abi.encodeWithSignature("setRequestsPaused(bool)", true));
        _assertMissing(abi.encodeWithSignature("requestsPaused()"));
        _assertMissing(abi.encodeWithSignature("transferOwnership(address)", recipientB));
        _assertMissing(abi.encodeWithSignature("withdraw(address,uint256)", recipientB, 1));
        _assertMissing(abi.encodeWithSignature("upgradeTo(address)", recipientB));
        _assertMissing(abi.encodeWithSignature("pause()"));

        assertEq(platformA.revenueRecipient(), recipientA);
        assertEq(platformA.requestPrice(), 1 ether);
        assertEq(platformA.maxPending(), 2);
        assertEq(platformB.revenueRecipient(), recipientB);
        assertEq(platformB.requestPrice(), 0);
        assertEq(platformB.maxPending(), 3);
    }

    function test_RequestZeroMaxPendingMeansUnlimited() public {
        PlatformRandomness unlimited = new PlatformRandomness(recipientA, "Unlimited", 0, 0);

        for (uint256 index; index < 300; ++index) {
            // The loop bound proves this test-only narrowing conversion is safe.
            // forge-lint: disable-next-line(unsafe-typecast)
            vm.prank(address(uint160(index + 1_000)));
            unlimited.requestRandomness();
        }

        assertEq(unlimited.maxPending(), 0);
        assertEq(unlimited.pendingCount(), 300);
        assertEq(unlimited.nextRequestId(), 301);
    }

    function test_RequestRejectsZeroRevenueRecipient() public {
        vm.expectRevert(PlatformRandomness.InvalidRevenueRecipient.selector);
        new PlatformRandomness(address(0), "Invalid", 0, 0);
    }

    function test_RequestRevenueSweepIsPermissionlessFixedAndInstanceLocal() public {
        vm.prank(alice);
        platformA.requestRandomness{value: 1 ether}();

        uint256 recipientBalanceBefore = recipientA.balance;
        vm.expectEmit(true, true, false, true, address(platformA));
        emit RevenueWithdrawn(bob, recipientA, 1 ether);
        vm.prank(bob);
        platformA.withdrawRevenue();

        assertEq(recipientA.balance, recipientBalanceBefore + 1 ether);
        assertEq(bob.balance, 20 ether);
        assertEq(address(platformA).balance, 0);
        assertEq(address(platformB).balance, 0);
    }

    function test_RequestRevenueSweepFailureRollsBackAndDoesNotLockGuard() public {
        ToggleRevenueRecipient recipient = new ToggleRevenueRecipient();
        PlatformRandomness rejectingPlatform = recipient.randomness();

        vm.prank(alice);
        rejectingPlatform.requestRandomness{value: 1 ether}();

        vm.expectRevert(PlatformRandomness.TransferFailed.selector);
        vm.prank(bob);
        rejectingPlatform.withdrawRevenue();

        assertEq(address(rejectingPlatform).balance, 1 ether);
        assertEq(rejectingPlatform.pendingCount(), 1);

        recipient.allowRevenue();
        vm.prank(bob);
        rejectingPlatform.withdrawRevenue();

        assertEq(address(recipient).balance, 1 ether);
        assertEq(address(rejectingPlatform).balance, 0);
    }

    function test_RequestForcedMonCanOnlySweepToFixedRecipient() public {
        vm.deal(address(platformA), 3 ether);
        uint256 recipientBalanceBefore = recipientA.balance;

        vm.prank(bob);
        platformA.withdrawRevenue();

        assertEq(recipientA.balance, recipientBalanceBefore + 3 ether);
        assertEq(bob.balance, 20 ether);
        assertEq(address(platformA).balance, 0);
    }

    function test_RequestRuntimeCodeIsIdenticalAcrossFrozenConfigurations() public view {
        assertEq(address(platformA).codehash, address(platformB).codehash);
        assertNotEq(platformA.revenueRecipient(), platformB.revenueRecipient());
        assertNotEq(platformA.requestPrice(), platformB.requestPrice());
        assertNotEq(platformA.maxPending(), platformB.maxPending());
    }

    function test_RequestRevenueSweepRejectsEmptyBalance() public {
        vm.expectRevert(PlatformRandomness.NoRevenue.selector);
        vm.prank(bob);
        platformA.withdrawRevenue();
    }

    function test_RequestRevenueSweepBlocksReentrancy() public {
        ReentrantRevenueRecipient recipient = new ReentrantRevenueRecipient();
        PlatformRandomness reentrantPlatform = recipient.randomness();

        vm.prank(alice);
        reentrantPlatform.requestRandomness{value: 1 ether}();
        vm.prank(bob);
        reentrantPlatform.withdrawRevenue();

        assertTrue(recipient.attemptedReentry());
        assertFalse(recipient.reentrySucceeded());
        assertEq(address(recipient).balance, 1 ether);
        assertEq(address(reentrantPlatform).balance, 0);
    }

    function test_RequestProtocolFeeIsPermanentlyZeroOnEveryInstance() public view {
        assertEq(platformA.protocolFee(), 0);
        assertEq(platformB.protocolFee(), 0);
    }

    function test_FinalizeRejectsCallsThroughThirdTargetPlusOne() public {
        (uint256 requestId, PlatformRandomness.Request memory request) = _requestForAlice(platformA, 1 ether);
        (bytes memory header1, bytes memory header2, bytes memory header3) = _headers(request);

        vm.roll(request.thirdTargetBlock);
        vm.expectRevert(
            abi.encodeWithSelector(
                PlatformRandomness.FinalizationTooEarly.selector, request.thirdTargetBlock, request.thirdTargetBlock + 2
            )
        );
        vm.prank(alice);
        platformA.finalizeRandomness(requestId, header1, header2, header3);

        vm.roll(request.thirdTargetBlock + 1);
        vm.expectRevert(
            abi.encodeWithSelector(
                PlatformRandomness.FinalizationTooEarly.selector,
                request.thirdTargetBlock + 1,
                request.thirdTargetBlock + 2
            )
        );
        vm.prank(alice);
        platformA.finalizeRandomness(requestId, header1, header2, header3);
    }

    function test_FinalizeAtPlusTwoAuthenticatesHeadersAndStoresExpectedSeed() public {
        (uint256 requestId, PlatformRandomness.Request memory request) = _requestForAlice(platformA, 1 ether);
        (bytes memory header1, bytes memory header2, bytes memory header3) = _headers(request);

        vm.roll(request.thirdTargetBlock + 2);
        _setRecentHashes(request, header1, header2, header3);

        bytes32 expected = _expectedSeed(address(platformA), requestId, alice);

        vm.expectEmit(true, true, true, true, address(platformA));
        emit RandomnessFinalized(requestId, alice, alice, expected);
        vm.prank(alice);
        bytes32 result = platformA.finalizeRandomness(requestId, header1, header2, header3);

        PlatformRandomness.Request memory stored = platformA.getRequest(requestId);
        assertEq(result, expected);
        assertEq(stored.result, expected);
        assertEq(stored.requester, alice);
        assertEq(stored.finalizer, alice);
        assertTrue(stored.finalized);
        assertEq(platformA.pendingCount(), 0);
        assertEq(address(platformA).balance, 1 ether);
    }

    function test_FinalizeIsRequesterOnlyThroughPlus63AndPermissionlessAtPlus64() public {
        vm.roll(REQUEST_BLOCK);
        vm.startPrank(alice);
        uint256 firstId = platformA.requestRandomness{value: 1 ether}();
        uint256 secondId = platformA.requestRandomness{value: 1 ether}();
        vm.stopPrank();

        PlatformRandomness.Request memory first = platformA.getRequest(firstId);
        (bytes memory header1, bytes memory header2, bytes memory header3) = _headers(first);

        vm.roll(first.thirdTargetBlock + 63);
        _setRecentHashes(first, header1, header2, header3);
        vm.expectRevert(abi.encodeWithSelector(PlatformRandomness.OnlyRequester.selector, alice));
        vm.prank(bob);
        platformA.finalizeRandomness(firstId, header1, header2, header3);

        vm.prank(alice);
        platformA.finalizeRandomness(firstId, header1, header2, header3);

        vm.roll(first.thirdTargetBlock + 64);
        vm.prank(bob);
        platformA.finalizeRandomness(secondId, header1, header2, header3);

        PlatformRandomness.Request memory rescued = platformA.getRequest(secondId);
        assertEq(rescued.requester, alice);
        assertEq(rescued.finalizer, bob);
        assertTrue(rescued.finalized);
        assertEq(platformA.pendingCount(), 0);
        assertEq(address(platformA).balance, 2 ether);
    }

    function test_FinalizeRejectsDuplicateAndCannotOverwriteRescuedResult() public {
        (uint256 requestId, PlatformRandomness.Request memory request) = _requestForAlice(platformA, 1 ether);
        (bytes memory header1, bytes memory header2, bytes memory header3) = _headers(request);
        vm.roll(request.thirdTargetBlock + 64);
        _setRecentHashes(request, header1, header2, header3);

        vm.prank(bob);
        bytes32 original = platformA.finalizeRandomness(requestId, header1, header2, header3);

        vm.expectRevert(PlatformRandomness.AlreadyFinalized.selector);
        vm.prank(alice);
        platformA.finalizeRandomness(requestId, header1, header2, header3);

        PlatformRandomness.Request memory stored = platformA.getRequest(requestId);
        assertEq(stored.result, original);
        assertEq(stored.requester, alice);
        assertEq(stored.finalizer, bob);
        assertEq(platformA.pendingCount(), 0);
        assertEq(address(platformA).balance, 1 ether);
        assertEq(bob.balance, 20 ether);
    }

    function test_FinalizeRejectsHeaderWhoseHashIsNotCanonical() public {
        (uint256 requestId, PlatformRandomness.Request memory request) = _requestForAlice(platformA, 1 ether);
        (bytes memory header1, bytes memory header2, bytes memory header3) = _headers(request);
        vm.roll(request.thirdTargetBlock + 2);
        _setRecentHashes(request, header1, header2, header3);

        bytes32 canonicalHash = keccak256("different canonical header");
        vm.setBlockhash(request.firstTargetBlock, canonicalHash);

        vm.expectRevert(
            abi.encodeWithSelector(
                PlatformRandomness.HeaderHashMismatch.selector,
                request.firstTargetBlock,
                canonicalHash,
                keccak256(header1)
            )
        );
        vm.prank(alice);
        platformA.finalizeRandomness(requestId, header1, header2, header3);
    }

    function test_FinalizeRejectsCanonicalHeaderWithWrongEncodedBlockNumber() public {
        (uint256 requestId, PlatformRandomness.Request memory request) = _requestForAlice(platformA, 1 ether);
        (, bytes memory header2, bytes memory header3) = _headers(request);
        bytes memory wrongHeader1 = _fixtureHeader(request.firstTargetBlock + 1, MIX_HASH_ONE);

        vm.roll(request.thirdTargetBlock + 2);
        vm.setBlockhash(request.firstTargetBlock, keccak256(wrongHeader1));
        vm.setBlockhash(request.secondTargetBlock, keccak256(header2));
        vm.setBlockhash(request.thirdTargetBlock, keccak256(header3));

        vm.expectRevert(
            abi.encodeWithSelector(
                PlatformRandomness.HeaderBlockMismatch.selector, request.firstTargetBlock, request.firstTargetBlock + 1
            )
        );
        vm.prank(alice);
        platformA.finalizeRandomness(requestId, wrongHeader1, header2, header3);
    }

    function test_FinalizeRejectsMissingRecentCanonicalBlockHash() public {
        (uint256 requestId, PlatformRandomness.Request memory request) = _requestForAlice(platformA, 1 ether);
        (bytes memory header1, bytes memory header2, bytes memory header3) = _headers(request);
        vm.roll(request.thirdTargetBlock + 2);
        vm.setBlockhash(request.firstTargetBlock, keccak256(header1));
        vm.setBlockhash(request.secondTargetBlock, keccak256(header2));
        vm.setBlockhash(request.thirdTargetBlock, bytes32(0));

        vm.expectRevert(
            abi.encodeWithSelector(PlatformRandomness.MissingCanonicalBlockHash.selector, request.thirdTargetBlock)
        );
        vm.prank(alice);
        platformA.finalizeRandomness(requestId, header1, header2, header3);
    }

    function test_FinalizeAuthenticatesExpiredBlockhashesThroughEip2935Calldata() public {
        (uint256 requestId, PlatformRandomness.Request memory request) = _requestForAlice(platformA, 1 ether);
        (bytes memory header1, bytes memory header2, bytes memory header3) = _headers(request);
        vm.roll(request.thirdTargetBlock + 300);

        _mockHistory(request.firstTargetBlock, keccak256(header1));
        _mockHistory(request.secondTargetBlock, keccak256(header2));
        _mockHistory(request.thirdTargetBlock, keccak256(header3));
        vm.expectCall(HISTORY_STORAGE, abi.encode(request.firstTargetBlock));
        vm.expectCall(HISTORY_STORAGE, abi.encode(request.secondTargetBlock));
        vm.expectCall(HISTORY_STORAGE, abi.encode(request.thirdTargetBlock));

        vm.prank(bob);
        bytes32 result = platformA.finalizeRandomness(requestId, header1, header2, header3);

        assertEq(result, _expectedSeed(address(platformA), requestId, alice));
        assertEq(platformA.getRequest(requestId).finalizer, bob);
    }

    function test_FinalizeRejectsFailedEip2935HistoryCall() public {
        (uint256 requestId, PlatformRandomness.Request memory request) = _requestForAlice(platformA, 1 ether);
        (bytes memory header1, bytes memory header2, bytes memory header3) = _headers(request);
        vm.roll(request.thirdTargetBlock + 300);
        vm.mockCallRevert(HISTORY_STORAGE, abi.encode(request.firstTargetBlock), "history unavailable");

        vm.expectRevert(
            abi.encodeWithSelector(PlatformRandomness.MissingCanonicalBlockHash.selector, request.firstTargetBlock)
        );
        vm.prank(bob);
        platformA.finalizeRandomness(requestId, header1, header2, header3);
    }

    function test_FinalizeRejectsNon32ByteEip2935HistoryReturn() public {
        (uint256 requestId, PlatformRandomness.Request memory request) = _requestForAlice(platformA, 1 ether);
        (bytes memory header1, bytes memory header2, bytes memory header3) = _headers(request);
        vm.roll(request.thirdTargetBlock + 300);
        vm.mockCall(HISTORY_STORAGE, abi.encode(request.firstTargetBlock), hex"1234");

        vm.expectRevert(
            abi.encodeWithSelector(PlatformRandomness.MissingCanonicalBlockHash.selector, request.firstTargetBlock)
        );
        vm.prank(bob);
        platformA.finalizeRandomness(requestId, header1, header2, header3);
    }

    function test_FinalizeRejectsZeroEip2935HistoryReturn() public {
        (uint256 requestId, PlatformRandomness.Request memory request) = _requestForAlice(platformA, 1 ether);
        (bytes memory header1, bytes memory header2, bytes memory header3) = _headers(request);
        vm.roll(request.thirdTargetBlock + 300);
        vm.mockCall(HISTORY_STORAGE, abi.encode(request.firstTargetBlock), abi.encode(bytes32(0)));

        vm.expectRevert(
            abi.encodeWithSelector(PlatformRandomness.MissingCanonicalBlockHash.selector, request.firstTargetBlock)
        );
        vm.prank(bob);
        platformA.finalizeRandomness(requestId, header1, header2, header3);
    }

    function test_FinalizeUsesContractAddressToSeparateOtherwiseIdenticalRequests() public {
        vm.roll(REQUEST_BLOCK);
        vm.prank(alice);
        uint256 requestIdA = platformA.requestRandomness{value: 1 ether}();
        vm.prank(alice);
        uint256 requestIdB = platformB.requestRandomness();

        PlatformRandomness.Request memory request = platformA.getRequest(requestIdA);
        (bytes memory header1, bytes memory header2, bytes memory header3) = _headers(request);
        vm.roll(request.thirdTargetBlock + 2);
        _setRecentHashes(request, header1, header2, header3);

        vm.prank(alice);
        bytes32 resultA = platformA.finalizeRandomness(requestIdA, header1, header2, header3);
        vm.prank(alice);
        bytes32 resultB = platformB.finalizeRandomness(requestIdB, header1, header2, header3);

        assertEq(resultA, _expectedSeed(address(platformA), requestIdA, alice));
        assertEq(resultB, _expectedSeed(address(platformB), requestIdB, alice));
        assertNotEq(resultA, resultB);
    }

    function test_FinalizeKeepsConfigurationUnchanged() public {
        (uint256 requestId, PlatformRandomness.Request memory request) = _requestForAlice(platformA, 1 ether);
        (bytes memory header1, bytes memory header2, bytes memory header3) = _headers(request);

        vm.roll(request.thirdTargetBlock + 2);
        _setRecentHashes(request, header1, header2, header3);
        vm.prank(alice);
        platformA.finalizeRandomness(requestId, header1, header2, header3);

        assertTrue(platformA.getRequest(requestId).finalized);
        assertEq(platformA.pendingCount(), 0);
        assertEq(platformA.revenueRecipient(), recipientA);
        assertEq(platformA.requestPrice(), 1 ether);
        assertEq(platformA.maxPending(), 2);
    }

    function test_FinalizeDrawIsPermanentAndBounded() public {
        (uint256 requestId, PlatformRandomness.Request memory request) = _requestForAlice(platformA, 1 ether);

        vm.expectRevert(PlatformRandomness.RequestNotFinalized.selector);
        platformA.draw(requestId, 100);

        (bytes memory header1, bytes memory header2, bytes memory header3) = _headers(request);
        vm.roll(request.thirdTargetBlock + 2);
        _setRecentHashes(request, header1, header2, header3);
        vm.prank(alice);
        bytes32 result = platformA.finalizeRandomness(requestId, header1, header2, header3);

        vm.roll(request.thirdTargetBlock + 20_000);
        assertEq(platformA.draw(requestId, 100), uint256(result) % 100);
        assertLt(platformA.draw(requestId, 100), 100);

        vm.expectRevert(PlatformRandomness.InvalidUpperBound.selector);
        platformA.draw(requestId, 0);
    }

    function test_DrawAcceptsCandidateAtOrAboveRejectionThresholdDirectly() public view {
        assertEq(drawHarness.exposedDraw(bytes32(uint256(123)), 100), 23);
    }

    function test_DrawDomainSeparatesAndRehashesRejectedCandidate() public view {
        bytes32 seed = bytes32(0);
        uint256 firstRehash = uint256(keccak256(abi.encode("MONAD_PUBLIC_RANDOMNESS_DRAW_V1", seed, uint256(0))));

        assertGe(firstRehash, 36, "fixture must accept the first domain-separated rehash");
        assertEq(drawHarness.exposedDraw(seed, 100), firstRehash % 100);
    }

    function testFuzz_DrawAlwaysReturnsInsideBound(bytes32 seed, uint256 rawUpperBound) public view {
        uint256 upperBound = bound(rawUpperBound, 1, type(uint128).max);
        assertLt(drawHarness.exposedDraw(seed, upperBound), upperBound);
    }

    function testFuzz_FrozenConfigurationKeepsIdenticalRuntime(
        address revenueRecipient,
        uint96 requestPrice,
        uint256 maxPending
    ) public {
        vm.assume(revenueRecipient != address(0));
        PlatformRandomness candidate =
            new PlatformRandomness(revenueRecipient, "Fuzz configuration", requestPrice, maxPending);

        assertEq(address(candidate).codehash, address(platformA).codehash);
        assertEq(candidate.revenueRecipient(), revenueRecipient);
        assertEq(candidate.requestPrice(), requestPrice);
        assertEq(candidate.maxPending(), maxPending);
        assertTrue(candidate.CONFIGURATION_LOCKED());
    }

    function testFuzz_PendingCountTracksFinalizeAndExpiryLifecycle(uint8 rawRequests, uint8 rawFinalized) public {
        uint256 requestCount = bound(rawRequests, 1, 16);
        uint256 finalizedCount = bound(rawFinalized, 0, requestCount);
        PlatformRandomness unlimited = new PlatformRandomness(recipientA, "Lifecycle fuzz", 0, 0);

        vm.roll(REQUEST_BLOCK);
        vm.startPrank(alice);
        for (uint256 index; index < requestCount; ++index) {
            unlimited.requestRandomness();
        }
        vm.stopPrank();
        assertEq(unlimited.pendingCount(), requestCount);

        PlatformRandomness.Request memory first = unlimited.getRequest(1);
        (bytes memory header1, bytes memory header2, bytes memory header3) = _headers(first);
        vm.roll(first.thirdTargetBlock + 2);
        _setRecentHashes(first, header1, header2, header3);

        vm.startPrank(alice);
        for (uint256 requestId = 1; requestId <= finalizedCount; ++requestId) {
            unlimited.finalizeRandomness(requestId, header1, header2, header3);
        }
        vm.stopPrank();
        assertEq(unlimited.pendingCount(), requestCount - finalizedCount);

        vm.roll(first.firstTargetBlock + 8_192);
        for (uint256 requestId = finalizedCount + 1; requestId <= requestCount; ++requestId) {
            vm.prank(bob);
            unlimited.expireRequest(requestId);
        }
        assertEq(unlimited.pendingCount(), 0);
        assertEq(unlimited.nextRequestId(), requestCount + 1);
    }

    function test_ExpireRejectsAtLastFinalizableBlockAndAllowsAnyoneAtNextBlock() public {
        (uint256 requestId, PlatformRandomness.Request memory request) = _requestForAlice(platformA, 1 ether);
        uint256 lastFinalizableBlock = request.firstTargetBlock + 8_191;
        uint256 firstExpirationBlock = lastFinalizableBlock + 1;

        vm.roll(lastFinalizableBlock);
        vm.expectRevert(
            abi.encodeWithSelector(
                PlatformRandomness.ExpirationTooEarly.selector, lastFinalizableBlock, firstExpirationBlock
            )
        );
        vm.prank(bob);
        platformA.expireRequest(requestId);

        uint256 aliceBalance = alice.balance;
        uint256 bobBalance = bob.balance;
        uint256 platformBalance = address(platformA).balance;

        vm.roll(firstExpirationBlock);
        vm.expectEmit(true, true, true, true, address(platformA));
        emit RandomnessRequestExpired(requestId, alice, bob);
        vm.prank(bob);
        platformA.expireRequest(requestId);

        PlatformRandomness.Request memory expired = platformA.getRequest(requestId);
        assertTrue(expired.expired);
        assertFalse(expired.finalized);
        assertEq(expired.finalizer, address(0));
        assertEq(expired.result, bytes32(0));
        assertEq(platformA.pendingCount(), 0);
        assertEq(alice.balance, aliceBalance);
        assertEq(bob.balance, bobBalance);
        assertEq(address(platformA).balance, platformBalance);

        vm.prank(bob);
        uint256 replacementId = platformA.requestRandomness{value: 1 ether}();
        assertEq(replacementId, requestId + 1, "expiry restores only this platform's capacity");
    }

    function test_ExpirePermanentlyRejectsDuplicateExpirationAndFinalization() public {
        (uint256 requestId, PlatformRandomness.Request memory request) = _requestForAlice(platformA, 1 ether);
        vm.roll(request.firstTargetBlock + 8_192);

        vm.prank(bob);
        platformA.expireRequest(requestId);

        vm.expectRevert(PlatformRandomness.AlreadyExpired.selector);
        vm.prank(alice);
        platformA.expireRequest(requestId);

        vm.expectRevert(PlatformRandomness.RequestExpired.selector);
        vm.prank(alice);
        platformA.finalizeRandomness(requestId, hex"", hex"", hex"");

        assertEq(platformA.pendingCount(), 0);
    }

    function test_ExpireCannotOverwriteFinalizationAtLastAuthenticatableBlock() public {
        (uint256 requestId, PlatformRandomness.Request memory request) = _requestForAlice(platformA, 1 ether);
        (bytes memory header1, bytes memory header2, bytes memory header3) = _headers(request);
        uint256 lastFinalizableBlock = request.firstTargetBlock + 8_191;
        vm.roll(lastFinalizableBlock);
        _mockHistory(request.firstTargetBlock, keccak256(header1));
        _mockHistory(request.secondTargetBlock, keccak256(header2));
        _mockHistory(request.thirdTargetBlock, keccak256(header3));

        vm.prank(bob);
        bytes32 result = platformA.finalizeRandomness(requestId, header1, header2, header3);

        vm.expectRevert(PlatformRandomness.AlreadyFinalized.selector);
        vm.prank(alice);
        platformA.expireRequest(requestId);

        PlatformRandomness.Request memory finalized = platformA.getRequest(requestId);
        assertTrue(finalized.finalized);
        assertFalse(finalized.expired);
        assertEq(finalized.result, result);
        assertEq(platformA.pendingCount(), 0);
    }

    function test_ExpireOnOnePlatformDoesNotReleaseAnotherPlatformsPendingSlot() public {
        vm.roll(REQUEST_BLOCK);
        vm.prank(alice);
        uint256 requestIdA = platformA.requestRandomness{value: 1 ether}();
        vm.prank(alice);
        uint256 requestIdB = platformB.requestRandomness();

        PlatformRandomness.Request memory requestA = platformA.getRequest(requestIdA);
        vm.roll(requestA.firstTargetBlock + 8_192);
        vm.prank(bob);
        platformA.expireRequest(requestIdA);

        assertEq(platformA.pendingCount(), 0);
        assertEq(platformB.pendingCount(), 1);
        assertTrue(platformA.getRequest(requestIdA).expired);
        assertFalse(platformB.getRequest(requestIdB).expired);
    }

    function test_FinalizeRejectsAfterLastAuthenticatableBlockEvenWithMockedHistory() public {
        (uint256 requestId, PlatformRandomness.Request memory request) = _requestForAlice(platformA, 1 ether);
        (bytes memory header1, bytes memory header2, bytes memory header3) = _headers(request);
        uint256 lastFinalizableBlock = request.firstTargetBlock + 8_191;
        vm.roll(lastFinalizableBlock + 1);
        _mockHistory(request.firstTargetBlock, keccak256(header1));
        _mockHistory(request.secondTargetBlock, keccak256(header2));
        _mockHistory(request.thirdTargetBlock, keccak256(header3));

        vm.expectRevert(
            abi.encodeWithSelector(
                PlatformRandomness.RequestProofExpired.selector, lastFinalizableBlock + 1, lastFinalizableBlock
            )
        );
        vm.prank(bob);
        platformA.finalizeRandomness(requestId, header1, header2, header3);

        assertEq(platformA.pendingCount(), 1);
        assertFalse(platformA.getRequest(requestId).finalized);
        assertFalse(platformA.getRequest(requestId).expired);
    }

    function test_FinalizeRejectsUnknownRequest() public {
        vm.expectRevert(PlatformRandomness.RequestNotFound.selector);
        platformA.finalizeRandomness(999, hex"", hex"", hex"");

        vm.expectRevert(PlatformRandomness.RequestNotFound.selector);
        platformA.draw(999, 100);

        vm.expectRevert(PlatformRandomness.RequestNotFound.selector);
        platformA.expireRequest(999);
    }

    function _requestForAlice(PlatformRandomness target, uint256 value)
        private
        returns (uint256 requestId, PlatformRandomness.Request memory request)
    {
        vm.roll(REQUEST_BLOCK);
        vm.prank(alice);
        requestId = target.requestRandomness{value: value}();
        request = target.getRequest(requestId);
    }

    function _headers(PlatformRandomness.Request memory request)
        private
        pure
        returns (bytes memory header1, bytes memory header2, bytes memory header3)
    {
        header1 = _fixtureHeader(request.firstTargetBlock, MIX_HASH_ONE);
        header2 = _fixtureHeader(request.secondTargetBlock, MIX_HASH_TWO);
        header3 = _fixtureHeader(request.thirdTargetBlock, MIX_HASH_THREE);
    }

    function _fixtureHeader(uint256 blockNumber, bytes32 mixHash) private pure returns (bytes memory header) {
        require(blockNumber <= type(uint32).max, "fixture block exceeds uint32");

        header = MonadHeaderFixture.rawHeader();
        // The preceding bound proves this fixture-only narrowing conversion is safe.
        // forge-lint: disable-next-line(unsafe-typecast)
        bytes4 encodedBlockNumber = bytes4(uint32(blockNumber));
        _replaceOnce(header, hex"02b9ca6f", abi.encodePacked(encodedBlockNumber));
        _replaceOnce(header, abi.encodePacked(FIXTURE_MIX_HASH), abi.encodePacked(mixHash));
    }

    function _replaceOnce(bytes memory subject, bytes memory needle, bytes memory replacement) private pure {
        require(needle.length == replacement.length, "replacement length mismatch");
        require(subject.length >= needle.length, "needle too long");

        for (uint256 i; i <= subject.length - needle.length; ++i) {
            bool matches = true;
            for (uint256 j; j < needle.length; ++j) {
                if (subject[i + j] != needle[j]) {
                    matches = false;
                    break;
                }
            }
            if (!matches) {
                continue;
            }

            for (uint256 j; j < replacement.length; ++j) {
                subject[i + j] = replacement[j];
            }
            return;
        }

        revert("fixture field not found");
    }

    function _setRecentHashes(
        PlatformRandomness.Request memory request,
        bytes memory header1,
        bytes memory header2,
        bytes memory header3
    ) private {
        vm.setBlockhash(request.firstTargetBlock, keccak256(header1));
        vm.setBlockhash(request.secondTargetBlock, keccak256(header2));
        vm.setBlockhash(request.thirdTargetBlock, keccak256(header3));
    }

    function _mockHistory(uint256 blockNumber, bytes32 blockHash) private {
        vm.mockCall(HISTORY_STORAGE, abi.encode(blockNumber), abi.encode(blockHash));
    }

    function _assertMissing(bytes memory callData) private {
        (bool success, bytes memory returnData) = address(platformA).call(callData);
        assertFalse(success);
        assertEq(returnData.length, 0);
    }

    function _expectedSeed(address target, uint256 requestId, address requester) private view returns (bytes32) {
        return keccak256(
            abi.encode(
                "MONAD_PUBLIC_RANDOMNESS_V1",
                block.chainid,
                target,
                requestId,
                requester,
                MIX_HASH_ONE,
                MIX_HASH_TWO,
                MIX_HASH_THREE
            )
        );
    }
}
