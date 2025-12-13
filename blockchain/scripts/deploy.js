const hre = require("hardhat");

async function main() {
  const [deployer] = await hre.ethers.getSigners();
  console.log("Deploying with account:", await deployer.getAddress());

  const AgriChain = await hre.ethers.getContractFactory("AgriChain");
  const agri = await AgriChain.deploy();

  // ethers v6
  await agri.waitForDeployment();

  console.log("AgriChain deployed to:", agri.target);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
