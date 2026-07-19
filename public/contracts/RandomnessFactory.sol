// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {PlatformRandomness} from "./PlatformRandomness.sol";

/// @notice Ownerless, zero-fee helper for deploying isolated platform instances.
contract RandomnessFactory {
    uint256 public constant VERSION = 1;

    event PlatformDeployed(
        address indexed platform,
        address indexed revenueRecipient,
        string platformName,
        uint256 requestPrice,
        uint256 maxPending
    );

    function deployPlatform(
        address revenueRecipient,
        string calldata platformName,
        uint256 requestPrice,
        uint256 maxPending
    ) external returns (PlatformRandomness platform) {
        platform = new PlatformRandomness(revenueRecipient, platformName, requestPrice, maxPending);
        emit PlatformDeployed(address(platform), revenueRecipient, platformName, requestPrice, maxPending);
    }
}
