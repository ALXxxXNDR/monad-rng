// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {PlatformRandomness} from "./PlatformRandomness.sol";

/// @notice Ownerless, zero-fee helper for deploying isolated platform instances.
contract RandomnessFactory {
    event PlatformDeployed(
        address indexed platform,
        address indexed platformOwner,
        string platformName,
        uint256 requestPrice,
        uint256 maxPending
    );

    function deployPlatform(string calldata platformName, uint256 requestPrice, uint256 maxPending)
        external
        returns (PlatformRandomness platform)
    {
        platform = new PlatformRandomness(msg.sender, platformName, requestPrice, maxPending);
        emit PlatformDeployed(address(platform), msg.sender, platformName, requestPrice, maxPending);
    }
}
