// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

contract AgriChain {
    event LogAdded(uint256 indexed productId, string action, string location, uint256 timestamp);

    struct TraceLog {
        string action;
        string location;
        uint256 timestamp;
        address recorder;
    }
    mapping(uint256 => TraceLog[]) public productLogs;

    function addLog(uint256 _productId, string memory _action, string memory _location) public {
        productLogs[_productId].push(TraceLog({
            action: _action,
            location: _location,
            timestamp: block.timestamp,
            recorder: msg.sender
        }));
        emit LogAdded(_productId, _action, _location, block.timestamp);
    }

    // helper: số log của 1 product
    function getLogCount(uint256 _productId) public view returns (uint256) {
        return productLogs[_productId].length;
    }

    // helper: lấy 1 log
    function getLog(uint256 _productId, uint256 index) public view returns (string memory, string memory, uint256, address) {
        TraceLog storage t = productLogs[_productId][index];
        return (t.action, t.location, t.timestamp, t.recorder);
    }
}
