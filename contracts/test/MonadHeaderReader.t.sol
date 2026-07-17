// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";

import {MonadHeaderReader} from "../src/MonadHeaderReader.sol";
import {MonadHeaderFixture} from "./fixtures/MonadHeaderFixture.sol";

contract MonadHeaderReaderHarness {
    function readNumberAndMixHash(bytes calldata rawHeader) external pure returns (uint256 number, bytes32 mixHash) {
        return MonadHeaderReader.readNumberAndMixHash(rawHeader);
    }
}

contract MonadHeaderReaderTest is Test {
    MonadHeaderReaderHarness private harness;

    function setUp() public {
        harness = new MonadHeaderReaderHarness();
    }

    function test_ReadsNumberAndMixHashFromRealMonadHeader() public view {
        (uint256 number, bytes32 mixHash) = harness.readNumberAndMixHash(MonadHeaderFixture.rawHeader());

        assertEq(number, 45_730_415);
        assertEq(mixHash, 0x03ff4794124a285d6f8024f7620315ccf5233c1e252bb7843e45e3a06ff604e9);
    }

    function test_RevertsWhenTopLevelItemIsNotAList() public {
        vm.expectRevert(MonadHeaderReader.MalformedRlp.selector);
        harness.readNumberAndMixHash(hex"80");
    }

    function test_RevertsWhenListIsTruncated() public {
        vm.expectRevert(MonadHeaderReader.MalformedRlp.selector);
        harness.readNumberAndMixHash(hex"c201");
    }

    function test_RevertsWhenHeaderHasTrailingBytes() public {
        vm.expectRevert(MonadHeaderReader.MalformedRlp.selector);
        harness.readNumberAndMixHash(hex"c080");
    }

    function test_RevertsWhenAHeaderFieldIsNested() public {
        vm.expectRevert(MonadHeaderReader.InvalidFieldType.selector);
        harness.readNumberAndMixHash(hex"c1c0");
    }

    function test_RevertsWhenShortStringEncodingIsNotCanonical() public {
        vm.expectRevert(MonadHeaderReader.MalformedRlp.selector);
        harness.readNumberAndMixHash(hex"c28101");
    }

    function test_RevertsWhenLongStringFormEncodesPayloadShorterThan56Bytes() public {
        vm.expectRevert(MonadHeaderReader.MalformedRlp.selector);
        harness.readNumberAndMixHash(hex"c3b80180");
    }

    function test_RevertsWhenLongListFormEncodesPayloadShorterThan56Bytes() public {
        vm.expectRevert(MonadHeaderReader.MalformedRlp.selector);
        harness.readNumberAndMixHash(hex"f80180");
    }

    function test_RevertsWhenLengthOfLengthHasALeadingZero() public {
        bytes memory nonCanonicalHeader = abi.encodePacked(hex"f90038", new bytes(56));

        vm.expectRevert(MonadHeaderReader.MalformedRlp.selector);
        harness.readNumberAndMixHash(nonCanonicalHeader);
    }

    function test_RevertsWhenBlockNumberIsLongerThan32Bytes() public {
        bytes memory numberBytes = new bytes(33);
        numberBytes[0] = 0x01;
        bytes memory encodedNumber = abi.encodePacked(bytes1(0xa1), numberBytes);
        bytes memory encodedMixHash = abi.encodePacked(bytes1(0xa0), bytes32(uint256(1)));

        vm.expectRevert(MonadHeaderReader.InvalidBlockNumber.selector);
        harness.readNumberAndMixHash(_headerWith(encodedNumber, encodedMixHash));
    }

    function test_RevertsWhenMixHashIsNot32Bytes() public {
        bytes memory encodedMixHash = abi.encodePacked(bytes1(0x9f), new bytes(31));

        vm.expectRevert(MonadHeaderReader.InvalidMixHash.selector);
        harness.readNumberAndMixHash(_headerWith(hex"01", encodedMixHash));
    }

    function _headerWith(bytes memory encodedNumber, bytes memory encodedMixHash) private pure returns (bytes memory) {
        bytes memory payload = abi.encodePacked(hex"8080808080808080", encodedNumber, hex"80808080", encodedMixHash);

        if (payload.length <= 55) {
            return abi.encodePacked(bytes1(uint8(0xc0 + payload.length)), payload);
        }

        assert(payload.length <= type(uint8).max);
        return abi.encodePacked(hex"f8", bytes1(uint8(payload.length)), payload);
    }
}
