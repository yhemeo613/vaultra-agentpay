const fs = require("node:fs");
const path = require("node:path");
const { ethers, network } = require("hardhat");

async function main() {
  const [deployer] = await ethers.getSigners();
  const balance = await ethers.provider.getBalance(deployer.address);

  console.log(`network  : ${network.name}`);
  console.log(`deployer : ${deployer.address}`);
  console.log(`balance  : ${ethers.formatEther(balance)} BNB\n`);

  const token = await ethers.deployContract("AgentToken");
  await token.waitForDeployment();
  const tokenAddress = await token.getAddress();
  console.log(`AgentToken : ${tokenAddress}`);

  // 财库与仲裁人：demo 用部署者地址（生产应换成多签），仲裁人可用 ARBITER_ADDRESS 覆盖
  const treasury = process.env.TREASURY_ADDRESS || deployer.address;
  const arbiter = process.env.ARBITER_ADDRESS || deployer.address;

  const agentPay = await ethers.deployContract("AgentPay", [tokenAddress, treasury, arbiter]);
  await agentPay.waitForDeployment();
  const agentPayAddress = await agentPay.getAddress();
  console.log(`AgentPay   : ${agentPayAddress}`);
  console.log(`treasury   : ${treasury}`);
  console.log(`arbiter    : ${arbiter}`);

  const { chainId } = await ethers.provider.getNetwork();

  // 本地链上给演示账户发点 AGP，方便直接跑 402 demo（主网/测试网不做任何分发）
  if (Number(chainId) === 31337) {
    const signers = await ethers.getSigners();
    for (const account of signers.slice(1, 4)) {
      const tx = await token.transfer(account.address, ethers.parseEther("10000"));
      await tx.wait();
      console.log(`funded demo account ${account.address} with 10000 AGP`);
    }
  }

  const record = {
    network: network.name,
    chainId: Number(chainId),
    token: tokenAddress,
    agentPay: agentPayAddress,
    deployer: deployer.address,
    deployedAt: new Date().toISOString(),
  };

  const dir = path.join(__dirname, "..", "deployments");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${network.name}.json`);
  fs.writeFileSync(file, JSON.stringify(record, null, 2));
  console.log(`\n已保存部署记录 -> ${file}`);

  console.log("\n源码验证（部署后执行，注意参数顺序）:");
  console.log(`  npx hardhat verify --network ${network.name} ${tokenAddress}`);
  console.log(`  npx hardhat verify --network ${network.name} ${agentPayAddress} ${tokenAddress} ${treasury} ${arbiter}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
