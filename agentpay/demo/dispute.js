#!/usr/bin/env node
"use strict";

/**
 * 仲裁端到端演示（本地链）
 *
 * 两笔托管：
 *   第一笔：付款 -> dispute -> 仲裁判服务方胜（net 给 provider，fee 给财库）
 *   第二笔：付款 -> dispute -> 仲裁判付款方胜（原额退回）
 *
 * 仲裁人在本地 demo 里是部署者（account #0，0xac09...）。
 */

const fs = require("node:fs");
const path = require("node:path");
const { ethers } = require("ethers");
const { AgentPayClient } = require("../sdk/agentpay-client");

const ENDPOINT = process.env.ENDPOINT || "http://127.0.0.1:4021/v1/infer";
const RPC_URL = process.env.RPC_URL || "http://127.0.0.1:8545";

// 付款方 = hardhat 账户 #1；仲裁人 = 账户 #0（部署者，demo 配置）
const CALLER_KEY = process.env.CALLER_KEY || "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
const ARBITER_KEY = process.env.ARBITER_KEY || "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";

const CERTS_DIR = path.join(__dirname, "..", "certs");
const TLS = {
  ca: fs.existsSync(path.join(CERTS_DIR, "server.crt")) ? fs.readFileSync(path.join(CERTS_DIR, "server.crt")) : undefined,
  cert: fs.existsSync(path.join(CERTS_DIR, "client.crt")) ? fs.readFileSync(path.join(CERTS_DIR, "client.crt")) : undefined,
  key: fs.existsSync(path.join(CERTS_DIR, "client.key")) ? fs.readFileSync(path.join(CERTS_DIR, "client.key")) : undefined,
  rejectUnauthorized: false,
  servername: "localhost",
};

const cfgPath = path.join(__dirname, "service.json");
if (!fs.existsSync(cfgPath)) throw new Error("找不到 demo/service.json，请先运行 scripts/register-service.js");
const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"));

const STATE = ["OPEN", "CLAIMED", "REFUNDED", "DISPUTED", "RESOLVED"];

async function main() {
  const client = new AgentPayClient({
    rpcUrl: RPC_URL,
    privateKey: CALLER_KEY,
    token: cfg.token,
    agentPay: cfg.agentPay,
    tls: TLS,
  });

  const provider = new ethers.JsonRpcProvider(RPC_URL);
  const arbiterWallet = new ethers.Wallet(ARBITER_KEY, provider);

  const ABI = [
    "function dispute(bytes32 memo)",
    "function resolve(bytes32 memo, bool toProvider)",
    "function arbiter() view returns (address)",
    "function escrows(bytes32 memo) view returns (address,bytes32,uint96,uint96,uint64,uint8)",
    "function services(bytes32 id) view returns (address,uint96,string,bool)",
  ];

  // dispute 必须由付款方发起（与 payChallenge 共享同一个 NonceManager）；
  // resolve 只有仲裁人能调
  const apPayer = new ethers.Contract(cfg.agentPay, ABI, client.getSigner());
  const apArbiter = new ethers.Contract(cfg.agentPay, ABI, arbiterWallet);

  const token = new ethers.Contract(cfg.token, ["function balanceOf(address) view returns (uint256)"], provider);
  const service = await apArbiter.services(cfg.serviceId);
  const providerAddr = service[0];

  console.log(`付款方  : ${await client.whoami()}`);
  console.log(`服务方  : ${providerAddr}`);
  console.log(`仲裁人  : ${await apArbiter.arbiter()}\n`);

  async function payAndDispute(label, prompt) {
    const first = await client.request(ENDPOINT, prompt);
    if (first.status !== 402) throw new Error(`预期 402，实际 ${first.status}`);
    const payment = await client.payChallenge(first.body.challenge);
    console.log(`[${label}] 付款 tx: ${payment.txHash.slice(0, 16)}...`);

    const tx = await apPayer.dispute(payment.challengeId);
    await tx.wait();
    console.log(`[${label}] dispute（付款方发起）tx: ${tx.hash.slice(0, 16)}...`);
    return payment;
  }

  const balances = async () => ({
    caller: ethers.formatEther(await token.balanceOf(await client.whoami())),
    provider: ethers.formatEther(await token.balanceOf(providerAddr)),
    contract: ethers.formatEther(await token.balanceOf(cfg.agentPay)),
  });

  console.log("== 第一笔：仲裁判服务方胜 ==");
  const p1 = await payAndDispute("A", "这笔争议判给服务方");
  let b = await balances();
  console.log(`  dispute 后: caller=${b.caller} · provider=${b.provider} · contract=${b.contract}`);
  const r1 = await apArbiter.resolve(p1.challengeId, true);
  await r1.wait();
  let e1 = await apArbiter.escrows(p1.challengeId);
  b = await balances();
  console.log(`  resolve(toProvider=true) tx: ${r1.hash.slice(0, 16)}...`);
  console.log(`  结果 state=${STATE[e1[5]]}: caller=${b.caller} · provider=${b.provider} · contract=${b.contract}`);

  console.log("\n== 第二笔：仲裁判付款方胜 ==");
  const p2 = await payAndDispute("B", "这笔争议判给付款方");
  b = await balances();
  console.log(`  dispute 后: caller=${b.caller} · provider=${b.provider} · contract=${b.contract}`);
  const r2 = await apArbiter.resolve(p2.challengeId, false);
  await r2.wait();
  let e2 = await apArbiter.escrows(p2.challengeId);
  b = await balances();
  console.log(`  resolve(toProvider=false) tx: ${r2.hash.slice(0, 16)}...`);
  console.log(`  结果 state=${STATE[e2[5]]}: caller=${b.caller} · provider=${b.provider} · contract=${b.contract}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
