// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

library MonadHeaderReader {
    error MalformedRlp();
    error InvalidFieldType();
    error InvalidBlockNumber();
    error InvalidMixHash();

    uint256 private constant BLOCK_NUMBER_FIELD = 8;
    uint256 private constant MIX_HASH_FIELD = 13;

    struct RlpItem {
        uint256 dataOffset;
        uint256 dataLength;
        uint256 encodedLength;
        bool isList;
    }

    function readNumberAndMixHash(bytes calldata rawHeader) internal pure returns (uint256 number, bytes32 mixHash) {
        RlpItem memory outer = _decodeItem(rawHeader, 0, rawHeader.length);

        if (!outer.isList || outer.encodedLength != rawHeader.length) {
            revert MalformedRlp();
        }

        uint256 cursor = outer.dataOffset;
        uint256 payloadEnd = outer.dataOffset + outer.dataLength;
        uint256 fieldIndex;
        bool foundNumber;
        bool foundMixHash;

        while (cursor < payloadEnd) {
            RlpItem memory field = _decodeItem(rawHeader, cursor, payloadEnd);

            if (field.isList) {
                revert InvalidFieldType();
            }

            if (fieldIndex == BLOCK_NUMBER_FIELD) {
                number = _decodeBlockNumber(rawHeader, field.dataOffset, field.dataLength);
                foundNumber = true;
            } else if (fieldIndex == MIX_HASH_FIELD) {
                if (field.dataLength != 32) {
                    revert InvalidMixHash();
                }

                assembly ("memory-safe") {
                    mixHash := calldataload(add(rawHeader.offset, mload(field)))
                }
                foundMixHash = true;
            }

            cursor += field.encodedLength;
            ++fieldIndex;
        }

        if (cursor != payloadEnd) {
            revert MalformedRlp();
        }
        if (!foundNumber) {
            revert InvalidBlockNumber();
        }
        if (!foundMixHash) {
            revert InvalidMixHash();
        }
    }

    function _decodeBlockNumber(bytes calldata encoded, uint256 dataOffset, uint256 dataLength)
        private
        pure
        returns (uint256 number)
    {
        if (dataLength > 32 || (dataLength != 0 && encoded[dataOffset] == bytes1(0))) {
            revert InvalidBlockNumber();
        }

        for (uint256 i; i < dataLength; ++i) {
            number = (number << 8) | uint8(encoded[dataOffset + i]);
        }
    }

    function _decodeItem(bytes calldata encoded, uint256 cursor, uint256 limit)
        private
        pure
        returns (RlpItem memory item)
    {
        if (cursor >= limit) {
            revert MalformedRlp();
        }

        uint8 prefix = uint8(encoded[cursor]);

        if (prefix <= 0x7f) {
            return RlpItem(cursor, 1, 1, false);
        }

        if (prefix <= 0xb7) {
            item.dataLength = prefix - 0x80;
            item.dataOffset = cursor + 1;
            item.encodedLength = item.dataLength + 1;
            _requireFits(item.dataOffset, item.dataLength, limit);

            if (item.dataLength == 1 && uint8(encoded[item.dataOffset]) <= 0x7f) {
                revert MalformedRlp();
            }

            return item;
        }

        if (prefix <= 0xbf) {
            uint256 lengthOfLength = prefix - 0xb7;
            item.dataLength = _readLongLength(encoded, cursor + 1, lengthOfLength, limit);
            if (item.dataLength < 56) {
                revert MalformedRlp();
            }

            item.dataOffset = cursor + 1 + lengthOfLength;
            item.encodedLength = 1 + lengthOfLength + item.dataLength;
            _requireFits(item.dataOffset, item.dataLength, limit);
            return item;
        }

        if (prefix <= 0xf7) {
            item.dataLength = prefix - 0xc0;
            item.dataOffset = cursor + 1;
            item.encodedLength = item.dataLength + 1;
            item.isList = true;
            _requireFits(item.dataOffset, item.dataLength, limit);
            return item;
        }

        uint256 listLengthOfLength = prefix - 0xf7;
        item.dataLength = _readLongLength(encoded, cursor + 1, listLengthOfLength, limit);
        if (item.dataLength < 56) {
            revert MalformedRlp();
        }

        item.dataOffset = cursor + 1 + listLengthOfLength;
        item.encodedLength = 1 + listLengthOfLength + item.dataLength;
        item.isList = true;
        _requireFits(item.dataOffset, item.dataLength, limit);
        return item;
    }

    function _readLongLength(bytes calldata encoded, uint256 offset, uint256 lengthOfLength, uint256 limit)
        private
        pure
        returns (uint256 length)
    {
        _requireFits(offset, lengthOfLength, limit);
        if (encoded[offset] == bytes1(0)) {
            revert MalformedRlp();
        }

        for (uint256 i; i < lengthOfLength; ++i) {
            length = (length << 8) | uint8(encoded[offset + i]);
        }
    }

    function _requireFits(uint256 offset, uint256 length, uint256 limit) private pure {
        if (offset > limit || length > limit - offset) {
            revert MalformedRlp();
        }
    }
}
