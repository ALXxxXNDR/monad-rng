// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";

import {PlatformRandomness} from "../src/PlatformRandomness.sol";
import {MonadHeaderFixture} from "./fixtures/MonadHeaderFixture.sol";

contract ReentrantPlatformOwner {
    PlatformRandomness private immutable RANDOMNESS;
    uint256 private immutable REENTRY_AMOUNT;

    bool public attemptedReentry;
    bool public reentrySucceeded;

    constructor(PlatformRandomness randomness_, uint256 reentryAmount_) {
        RANDOMNESS = randomness_;
        REENTRY_AMOUNT = reentryAmount_;
    }

    function withdraw(address payable recipient, uint256 amount) external {
        RANDOMNESS.withdraw(recipient, amount);
    }

    receive() external payable {
        attemptedReentry = true;
        try RANDOMNESS.withdraw(payable(address(this)), REENTRY_AMOUNT) {
            reentrySucceeded = true;
        } catch {}
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

    address private ownerA = makeAddr("ownerA");
    address private ownerB = makeAddr("ownerB");
    address private alice = makeAddr("alice");
    address private bob = makeAddr("bob");

    PlatformRandomness private platformA;
    PlatformRandomness private platformB;

    function setUp() public {
        platformA = new PlatformRandomness(ownerA, "Platform A", 1 ether, 2);
        platformB = new PlatformRandomness(ownerB, "Platform B", 0, 3);

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
        assertEq(request.result, bytes32(0));
        assertEq(request.finalizer, address(0));
        assertEq(platformA.pendingCount(), 1);
        assertEq(platformA.nextRequestId(), 2);
        assertEq(address(platformA).balance, 1 ether);
        assertEq(platformA.platformName(), "Platform A");
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

    function test_RequestPriceChangesAffectOnlyFutureRequests() public {
        vm.prank(alice);
        uint256 firstId = platformA.requestRandomness{value: 1 ether}();

        vm.prank(ownerA);
        platformA.setRequestPrice(2 ether);

        vm.roll(1_100);
        vm.prank(bob);
        uint256 secondId = platformA.requestRandomness{value: 2 ether}();

        assertEq(platformA.getRequest(firstId).pricePaid, 1 ether);
        assertEq(platformA.getRequest(secondId).pricePaid, 2 ether);
        assertEq(platformA.getRequest(firstId).firstTargetBlock, 1_008);
        assertEq(platformA.getRequest(secondId).firstTargetBlock, 1_108);
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

    function test_RequestPauseOnOnePlatformDoesNotPauseAnother() public {
        vm.prank(ownerA);
        platformA.setRequestsPaused(true);

        vm.expectRevert(PlatformRandomness.RequestsArePaused.selector);
        vm.prank(alice);
        platformA.requestRandomness{value: 1 ether}();

        vm.prank(alice);
        uint256 requestIdB = platformB.requestRandomness();

        assertEq(requestIdB, 1);
        assertTrue(platformA.requestsPaused());
        assertFalse(platformB.requestsPaused());
    }

    function test_RequestAdministrationIsOwnerOnlyAndInstanceLocal() public {
        vm.expectRevert(PlatformRandomness.Unauthorized.selector);
        vm.prank(ownerB);
        platformA.setRequestPrice(9 ether);

        vm.expectRevert(PlatformRandomness.Unauthorized.selector);
        vm.prank(ownerB);
        platformA.setMaxPending(99);

        vm.expectRevert(PlatformRandomness.Unauthorized.selector);
        vm.prank(ownerB);
        platformA.setRequestsPaused(true);

        vm.prank(ownerB);
        platformB.setRequestPrice(3 ether);
        vm.prank(ownerB);
        platformB.setMaxPending(7);
        vm.prank(ownerB);
        platformB.setRequestsPaused(true);

        assertEq(platformA.requestPrice(), 1 ether);
        assertEq(platformA.maxPending(), 2);
        assertFalse(platformA.requestsPaused());
        assertEq(platformB.requestPrice(), 3 ether);
        assertEq(platformB.maxPending(), 7);
        assertTrue(platformB.requestsPaused());
    }

    function test_RequestCapCannotBeLoweredBelowCurrentPendingCount() public {
        vm.prank(alice);
        platformA.requestRandomness{value: 1 ether}();
        vm.prank(bob);
        platformA.requestRandomness{value: 1 ether}();

        vm.expectRevert(abi.encodeWithSelector(PlatformRandomness.MaxPendingBelowPending.selector, 1, 2));
        vm.prank(ownerA);
        platformA.setMaxPending(1);

        vm.prank(ownerA);
        platformA.setMaxPending(2);
        assertEq(platformA.maxPending(), 2);
    }

    function test_RequestOwnershipTransferRejectsUnauthorizedAndZeroOwner() public {
        vm.expectRevert(PlatformRandomness.Unauthorized.selector);
        vm.prank(ownerB);
        platformA.transferOwnership(ownerB);

        vm.expectRevert(PlatformRandomness.InvalidOwner.selector);
        vm.prank(ownerA);
        platformA.transferOwnership(address(0));

        vm.prank(ownerA);
        platformA.transferOwnership(ownerB);

        assertEq(platformA.owner(), ownerB);

        vm.expectRevert(PlatformRandomness.Unauthorized.selector);
        vm.prank(ownerA);
        platformA.setRequestPrice(4 ether);

        vm.prank(ownerB);
        platformA.setRequestPrice(4 ether);
        assertEq(platformA.requestPrice(), 4 ether);
    }

    function test_RequestRevenueWithdrawalIsOwnerOnlyAndInstanceLocal() public {
        vm.prank(alice);
        platformA.requestRandomness{value: 1 ether}();

        vm.expectRevert(PlatformRandomness.Unauthorized.selector);
        vm.prank(ownerB);
        platformA.withdraw(payable(ownerB), 1 ether);

        uint256 ownerBalanceBefore = ownerA.balance;
        vm.prank(ownerA);
        platformA.withdraw(payable(ownerA), 0.4 ether);

        assertEq(ownerA.balance, ownerBalanceBefore + 0.4 ether);
        assertEq(address(platformA).balance, 0.6 ether);
        assertEq(address(platformB).balance, 0);
    }

    function test_RequestWithdrawalRejectsInvalidRecipientAndExcessAmount() public {
        vm.prank(alice);
        platformA.requestRandomness{value: 1 ether}();

        vm.expectRevert(PlatformRandomness.InvalidRecipient.selector);
        vm.prank(ownerA);
        platformA.withdraw(payable(address(0)), 1);

        vm.expectRevert(abi.encodeWithSelector(PlatformRandomness.InsufficientBalance.selector, 1 ether, 2 ether));
        vm.prank(ownerA);
        platformA.withdraw(payable(ownerA), 2 ether);
    }

    function test_RequestWithdrawalBlocksReentrancy() public {
        vm.prank(alice);
        platformA.requestRandomness{value: 1 ether}();

        ReentrantPlatformOwner attacker = new ReentrantPlatformOwner(platformA, 0.5 ether);
        vm.prank(ownerA);
        platformA.transferOwnership(address(attacker));

        attacker.withdraw(payable(address(attacker)), 0.5 ether);

        assertTrue(attacker.attemptedReentry());
        assertFalse(attacker.reentrySucceeded());
        assertEq(address(attacker).balance, 0.5 ether);
        assertEq(address(platformA).balance, 0.5 ether);
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

    function test_FinalizeRemainsAvailableWhenNewRequestsArePausedAndSettingsChange() public {
        (uint256 requestId, PlatformRandomness.Request memory request) = _requestForAlice(platformA, 1 ether);
        (bytes memory header1, bytes memory header2, bytes memory header3) = _headers(request);

        vm.startPrank(ownerA);
        platformA.setRequestsPaused(true);
        platformA.setRequestPrice(99 ether);
        platformA.setMaxPending(1);
        vm.stopPrank();

        vm.roll(request.thirdTargetBlock + 2);
        _setRecentHashes(request, header1, header2, header3);
        vm.prank(alice);
        platformA.finalizeRandomness(requestId, header1, header2, header3);

        assertTrue(platformA.getRequest(requestId).finalized);
        assertEq(platformA.pendingCount(), 0);
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

    function test_FinalizeRejectsUnknownRequest() public {
        vm.expectRevert(PlatformRandomness.RequestNotFound.selector);
        platformA.finalizeRandomness(999, hex"", hex"", hex"");

        vm.expectRevert(PlatformRandomness.RequestNotFound.selector);
        platformA.draw(999, 100);
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
