// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {MonadHeaderReader} from "./MonadHeaderReader.sol";

contract PlatformRandomness {
    address public constant HISTORY_STORAGE = 0x0000F90827F1C53a10cb7A02335B175320002935;
    string internal constant DRAW_DOMAIN = "MONAD_PUBLIC_RANDOMNESS_DRAW_V1";

    error InvalidOwner();
    error Unauthorized();
    error IncorrectPayment(uint256 expected, uint256 received);
    error RequestsArePaused();
    error PendingLimitReached();
    error MaxPendingBelowPending(uint256 proposed, uint256 currentPending);
    error RequestNotFound();
    error InvalidRecipient();
    error InsufficientBalance(uint256 available, uint256 requested);
    error Reentrancy();
    error TransferFailed();
    error FinalizationTooEarly(uint256 currentBlock, uint256 firstAllowedBlock);
    error OnlyRequester(address requester);
    error AlreadyFinalized();
    error HeaderHashMismatch(uint256 blockNumber, bytes32 canonicalHash, bytes32 suppliedHeaderHash);
    error HeaderBlockMismatch(uint256 expectedBlockNumber, uint256 encodedBlockNumber);
    error MissingCanonicalBlockHash(uint256 blockNumber);
    error RequestNotFinalized();
    error InvalidUpperBound();
    error BlockNumberTooLarge(uint256 blockNumber);
    error PriceTooLarge(uint256 price);
    error ExpirationTooEarly(uint256 currentBlock, uint256 firstAllowedBlock);
    error RequestProofExpired(uint256 currentBlock, uint256 lastFinalizableBlock);
    error RequestExpired();
    error AlreadyExpired();

    enum RequestStatus {
        None,
        Pending,
        Finalized,
        Expired
    }

    struct Request {
        address requester;
        uint256 requestBlock;
        uint256 firstTargetBlock;
        uint256 secondTargetBlock;
        uint256 thirdTargetBlock;
        uint256 pricePaid;
        address finalizer;
        bytes32 result;
        bool finalized;
        bool expired;
    }

    struct StoredRequest {
        address requester;
        uint64 requestBlock;
        RequestStatus status;
        address finalizer;
        uint96 pricePaid;
        bytes32 result;
    }

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
    event RequestPriceUpdated(uint256 oldPrice, uint256 newPrice);
    event MaxPendingUpdated(uint256 oldMaxPending, uint256 newMaxPending);
    event RequestsPausedUpdated(bool paused);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    event RevenueWithdrawn(address indexed recipient, uint256 amount);

    address public owner;
    string public platformName;
    uint256 public requestPrice;
    uint256 public maxPending;
    uint256 public pendingCount;
    uint256 public nextRequestId = 1;
    bool public requestsPaused;

    mapping(uint256 requestId => StoredRequest request) private requests;
    bool private withdrawalEntered;

    modifier onlyOwner() {
        _requireOwner();
        _;
    }

    modifier nonReentrantWithdrawal() {
        _enterWithdrawal();
        _;
        _exitWithdrawal();
    }

    constructor(address owner_, string memory platformName_, uint256 requestPrice_, uint256 maxPending_) {
        if (owner_ == address(0)) {
            revert InvalidOwner();
        }
        if (requestPrice_ > type(uint96).max) {
            revert PriceTooLarge(requestPrice_);
        }

        owner = owner_;
        platformName = platformName_;
        requestPrice = requestPrice_;
        maxPending = maxPending_;

        emit OwnershipTransferred(address(0), owner_);
    }

    function requestRandomness() external payable returns (uint256 requestId) {
        if (requestsPaused) {
            revert RequestsArePaused();
        }
        if (msg.value != requestPrice) {
            revert IncorrectPayment(requestPrice, msg.value);
        }
        if (pendingCount >= maxPending) {
            revert PendingLimitReached();
        }
        if (block.number > uint256(type(uint64).max) - 40) {
            revert BlockNumberTooLarge(block.number);
        }
        if (msg.value > type(uint96).max) {
            revert PriceTooLarge(msg.value);
        }

        requestId = nextRequestId;
        nextRequestId = requestId + 1;
        ++pendingCount;

        uint256 firstTargetBlock = block.number + 8;
        uint256 secondTargetBlock = block.number + 24;
        uint256 thirdTargetBlock = block.number + 40;

        // The preceding bounds prove these packed-storage narrowing conversions are safe.
        // forge-lint: disable-next-line(unsafe-typecast)
        uint64 compressedRequestBlock = uint64(block.number);
        // forge-lint: disable-next-line(unsafe-typecast)
        uint96 compressedPricePaid = uint96(msg.value);

        requests[requestId] = StoredRequest({
            requester: msg.sender,
            requestBlock: compressedRequestBlock,
            status: RequestStatus.Pending,
            finalizer: address(0),
            pricePaid: compressedPricePaid,
            result: bytes32(0)
        });

        emit RandomnessRequested(
            requestId, msg.sender, block.number, firstTargetBlock, secondTargetBlock, thirdTargetBlock, msg.value
        );
    }

    function getRequest(uint256 requestId) external view returns (Request memory request) {
        StoredRequest storage stored = requests[requestId];
        if (stored.status == RequestStatus.None) {
            revert RequestNotFound();
        }

        uint256 requestBlock = uint256(stored.requestBlock);
        request = Request({
            requester: stored.requester,
            requestBlock: requestBlock,
            firstTargetBlock: requestBlock + 8,
            secondTargetBlock: requestBlock + 24,
            thirdTargetBlock: requestBlock + 40,
            pricePaid: uint256(stored.pricePaid),
            finalizer: stored.finalizer,
            result: stored.result,
            finalized: stored.status == RequestStatus.Finalized,
            expired: stored.status == RequestStatus.Expired
        });
    }

    function finalizeRandomness(
        uint256 requestId,
        bytes calldata header1,
        bytes calldata header2,
        bytes calldata header3
    ) external returns (bytes32 randomness) {
        StoredRequest storage request = requests[requestId];
        if (request.status == RequestStatus.None) {
            revert RequestNotFound();
        }
        if (request.status == RequestStatus.Finalized) {
            revert AlreadyFinalized();
        }
        if (request.status == RequestStatus.Expired) {
            revert RequestExpired();
        }

        uint256 thirdTargetBlock = uint256(request.requestBlock) + 40;

        uint256 firstAllowedBlock = thirdTargetBlock + 2;
        if (block.number < firstAllowedBlock) {
            revert FinalizationTooEarly(block.number, firstAllowedBlock);
        }
        uint256 lastFinalizableBlock = uint256(request.requestBlock) + 8 + 8_191;
        if (block.number > lastFinalizableBlock) {
            revert RequestProofExpired(block.number, lastFinalizableBlock);
        }
        if (block.number < thirdTargetBlock + 64 && msg.sender != request.requester) {
            revert OnlyRequester(request.requester);
        }

        randomness = _authenticateAndDerive(requestId, request, header1, header2, header3);

        request.finalizer = msg.sender;
        request.result = randomness;
        request.status = RequestStatus.Finalized;
        --pendingCount;

        emit RandomnessFinalized(requestId, request.requester, msg.sender, randomness);
    }

    function expireRequest(uint256 requestId) external {
        StoredRequest storage request = requests[requestId];
        if (request.status == RequestStatus.None) {
            revert RequestNotFound();
        }
        if (request.status == RequestStatus.Finalized) {
            revert AlreadyFinalized();
        }
        if (request.status == RequestStatus.Expired) {
            revert AlreadyExpired();
        }

        uint256 firstExpirationBlock = uint256(request.requestBlock) + 8 + 8_191 + 1;
        if (block.number < firstExpirationBlock) {
            revert ExpirationTooEarly(block.number, firstExpirationBlock);
        }

        request.status = RequestStatus.Expired;
        --pendingCount;

        emit RandomnessRequestExpired(requestId, request.requester, msg.sender);
    }

    function draw(uint256 requestId, uint256 upperBound) external view returns (uint256) {
        StoredRequest storage request = requests[requestId];
        if (request.status == RequestStatus.None) {
            revert RequestNotFound();
        }
        if (request.status != RequestStatus.Finalized) {
            revert RequestNotFinalized();
        }

        return _draw(request.result, upperBound);
    }

    function setRequestPrice(uint256 newPrice) external onlyOwner {
        if (newPrice > type(uint96).max) {
            revert PriceTooLarge(newPrice);
        }

        uint256 oldPrice = requestPrice;
        requestPrice = newPrice;
        emit RequestPriceUpdated(oldPrice, newPrice);
    }

    function setMaxPending(uint256 newMaxPending) external onlyOwner {
        if (newMaxPending < pendingCount) {
            revert MaxPendingBelowPending(newMaxPending, pendingCount);
        }

        uint256 oldMaxPending = maxPending;
        maxPending = newMaxPending;
        emit MaxPendingUpdated(oldMaxPending, newMaxPending);
    }

    function setRequestsPaused(bool paused) external onlyOwner {
        requestsPaused = paused;
        emit RequestsPausedUpdated(paused);
    }

    function withdraw(address payable recipient, uint256 amount) external onlyOwner nonReentrantWithdrawal {
        if (recipient == address(0)) {
            revert InvalidRecipient();
        }

        uint256 available = address(this).balance;
        if (amount > available) {
            revert InsufficientBalance(available, amount);
        }

        (bool success,) = recipient.call{value: amount}("");
        if (!success) {
            revert TransferFailed();
        }

        emit RevenueWithdrawn(recipient, amount);
    }

    function transferOwnership(address newOwner) external onlyOwner {
        if (newOwner == address(0)) {
            revert InvalidOwner();
        }

        address previousOwner = owner;
        owner = newOwner;
        emit OwnershipTransferred(previousOwner, newOwner);
    }

    function protocolFee() external pure returns (uint256) {
        return 0;
    }

    function _draw(bytes32 seed, uint256 upperBound) internal pure returns (uint256) {
        if (upperBound == 0) {
            revert InvalidUpperBound();
        }

        uint256 rejectionThreshold = (type(uint256).max - upperBound + 1) % upperBound;
        uint256 candidate = uint256(seed);
        uint256 counter;

        while (candidate < rejectionThreshold) {
            candidate = uint256(keccak256(abi.encode(DRAW_DOMAIN, seed, counter)));
            unchecked {
                ++counter;
            }
        }

        return candidate % upperBound;
    }

    function _deriveRandomness(
        uint256 requestId,
        address requester,
        bytes32 mixHash1,
        bytes32 mixHash2,
        bytes32 mixHash3
    ) private view returns (bytes32) {
        return keccak256(
            abi.encode(
                "MONAD_PUBLIC_RANDOMNESS_V1",
                block.chainid,
                address(this),
                requestId,
                requester,
                mixHash1,
                mixHash2,
                mixHash3
            )
        );
    }

    function _authenticateAndDerive(
        uint256 requestId,
        StoredRequest storage request,
        bytes calldata header1,
        bytes calldata header2,
        bytes calldata header3
    ) private view returns (bytes32) {
        uint256 requestBlock = uint256(request.requestBlock);
        bytes32 mixHash1 = _authenticateHeader(requestBlock + 8, header1);
        bytes32 mixHash2 = _authenticateHeader(requestBlock + 24, header2);
        bytes32 mixHash3 = _authenticateHeader(requestBlock + 40, header3);

        return _deriveRandomness(requestId, request.requester, mixHash1, mixHash2, mixHash3);
    }

    function _authenticateHeader(uint256 targetBlock, bytes calldata rawHeader) private view returns (bytes32 mixHash) {
        bytes32 canonicalHash = blockhash(targetBlock);
        if (canonicalHash == bytes32(0)) {
            canonicalHash = _historicalBlockHash(targetBlock);
        }
        if (canonicalHash == bytes32(0)) {
            revert MissingCanonicalBlockHash(targetBlock);
        }

        bytes32 suppliedHeaderHash = keccak256(rawHeader);
        if (suppliedHeaderHash != canonicalHash) {
            revert HeaderHashMismatch(targetBlock, canonicalHash, suppliedHeaderHash);
        }

        (uint256 encodedBlockNumber, bytes32 parsedMixHash) = MonadHeaderReader.readNumberAndMixHash(rawHeader);
        if (encodedBlockNumber != targetBlock) {
            revert HeaderBlockMismatch(targetBlock, encodedBlockNumber);
        }

        return parsedMixHash;
    }

    function _historicalBlockHash(uint256 targetBlock) private view returns (bytes32 historicalHash) {
        (bool success, bytes memory returnData) = HISTORY_STORAGE.staticcall(abi.encode(targetBlock));
        if (!success || returnData.length != 32) {
            return bytes32(0);
        }

        assembly ("memory-safe") {
            historicalHash := mload(add(returnData, 0x20))
        }
    }

    function _requireOwner() private view {
        if (msg.sender != owner) {
            revert Unauthorized();
        }
    }

    function _enterWithdrawal() private {
        if (withdrawalEntered) {
            revert Reentrancy();
        }
        withdrawalEntered = true;
    }

    function _exitWithdrawal() private {
        withdrawalEntered = false;
    }
}
