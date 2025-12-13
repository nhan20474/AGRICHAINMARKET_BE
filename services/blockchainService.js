import contract, { signer } from "../config/blockchain.js"; // signer export từ blockchain.js

export async function addLogOnChain(productId, action, location) {
  try {
    if (!signer) {
      throw new Error("PRIVATE_KEY chưa được cấu hình. Không thể gửi transaction");
    }

    const tx = await contract.addLog(productId, action, location);
    const receipt = await tx.wait();
    return { txHash: receipt.transactionHash, receipt };
  } catch (err) {
    console.error("addLogOnChain error:", err);
    throw err;
  }
}

export async function getLogCount(productId) {
  try {
    const count = await contract.getLogCount(productId);
    return count.toString();
  } catch (err) {
    console.error("getLogCount error:", err);
    throw err;
  }
}

export async function getLog(productId, index) {
  try {
    const res = await contract.getLog(productId, index);
    return {
      action: res[0],
      location: res[1],
      timestamp: Number(res[2]),
      recorder: res[3]
    };
  } catch (err) {
    console.error("getLog error:", err);
    throw err;
  }
}
