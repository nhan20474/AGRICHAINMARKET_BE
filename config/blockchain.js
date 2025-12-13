const { ethers } = require('ethers');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

// RPC và provider
const rpc = process.env.AMOY_RPC || 'https://rpc-amoy.polygon.technology';
const provider = new ethers.JsonRpcProvider(rpc);

// Signer từ PRIVATE_KEY
const privateKey = process.env.PRIVATE_KEY;
const signer = privateKey ? new ethers.Wallet(privateKey, provider) : null;

// Load ABI
const abiPath = path.join(__dirname, 'contractABI.json');
const abi = JSON.parse(fs.readFileSync(abiPath, 'utf8'));

// Address contract
const contractAddress = process.env.CONTRACT_ADDRESS;
if (!contractAddress) {
  console.warn('CONTRACT_ADDRESS chưa được thiết lập!');
}

// Khởi tạo contract với signer nếu có
const contract = new ethers.Contract(
  contractAddress,
  abi,
  signer || provider
);

// Export cả contract và signer
module.exports = { contract, signer };
