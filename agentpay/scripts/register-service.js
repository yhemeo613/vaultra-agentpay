const fs = require("node:fs");
const path = require("node:path");
const { ethers, network } = require("hardhat");

const SERVICE_NAME = process.env.SERVICE_ID || "infer-v1";
const PRICE_AGP = process.env.AGENT_PRICE || "1";
const ENDPOINT = process.env.AGENT_ENDPOINT || "http://127.0.0.1:4021/v1/infer";

async function main() {
  const recordPath = path.join(__dirname, "..", "deployments", `${network.name}.json`);
  if (!fs.existsSync(recordPath)) {
    throw new Error(`找不到部署记录 ${recordPath}，请先执行 scripts/deploy.js`);
  }
  const record = JSON.parse(fs.readFileSync(recordPath, "utf8"));

  const [signer] = await ethers.getSigners();
  const agentPay = await ethers.getContractAt("AgentPay", record.agentPay);

  const serviceId = ethers.id(SERVICE_NAME);
  const price = ethers.parseEther(PRICE_AGP);

  const current = await agentPay.services(serviceId);
  const owned = current.active && current.provider.toLowerCase() === signer.address.toLowerCase();

  if (owned && current.price === price) {
    console.log(`服务已存在且参数一致，跳过写入: ${SERVICE_NAME}`);
  } else {
    const tx = await agentPay.setService(serviceId, price, ENDPOINT);
    console.log(`setService tx: ${tx.hash}`);
    await tx.wait();
    console.log(`已注册服务 ${SERVICE_NAME}，单价 ${PRICE_AGP} AGP`);
  }

  const demoConfig = {
    network: network.name,
    chainId: record.chainId,
    token: record.token,
    agentPay: record.agentPay,
    serviceId,
    serviceName: SERVICE_NAME,
    price: price.toString(),
    provider: signer.address,
  };

  const outFile = path.join(__dirname, "..", "demo", "service.json");
  fs.writeFileSync(outFile, JSON.stringify(demoConfig, null, 2));
  console.log(`\n已写入 demo 配置 -> ${outFile}`);
  console.log(JSON.stringify(demoConfig, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
