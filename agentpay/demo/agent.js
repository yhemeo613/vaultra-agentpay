#!/usr/bin/env node
"use strict";

/**
 * Agent 自动付费循环（v3）
 *
 * 连续处理多个任务，每调用一次付费接口就自动走完
 * 402 -> 付款(escrow) -> 签名 -> 重试，最后汇报总花费。
 */

const fs = require("node:fs");
const path = require("node:path");
const { ethers } = require("ethers");
const { AgentPayClient } = require("../sdk/agentpay-client");

const ENDPOINT = process.env.ENDPOINT || "http://127.0.0.1:4021/v1/infer";
const RPC_URL = process.env.RPC_URL || "http://127.0.0.1:8545";

// hardhat 默认账户 #2，避免和 client.js 用同一账户
const DEFAULT_KEY = "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a";
const PRIVATE_KEY = process.env.PRIVATE_KEY || DEFAULT_KEY;

const CERTS_DIR = path.join(__dirname, "..", "certs");
const TLS = {
  ca: fs.existsSync(path.join(CERTS_DIR, "server.crt")) ? fs.readFileSync(path.join(CERTS_DIR, "server.crt")) : undefined,
  cert: fs.existsSync(path.join(CERTS_DIR, "client.crt")) ? fs.readFileSync(path.join(CERTS_DIR, "client.crt")) : undefined,
  key: fs.existsSync(path.join(CERTS_DIR, "client.key")) ? fs.readFileSync(path.join(CERTS_DIR, "client.key")) : undefined,
  rejectUnauthorized: false,
  servername: "localhost",
};

const cfgPath = path.join(__dirname, "service.json");
if (!fs.existsSync(cfgPath)) {
  throw new Error("找不到 demo/service.json，请先运行 scripts/register-service.js");
}
const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"));

const TASKS = [
  "总结一下今天的链上稳定币流动",
  "给 BSC 上做 agent 微支付写一句卖点",
  "解释为什么零交易税对信任更重要",
];

async function main() {
  const client = new AgentPayClient({
    rpcUrl: RPC_URL,
    privateKey: PRIVATE_KEY,
    token: cfg.token,
    agentPay: cfg.agentPay,
    tls: TLS,
  });

  const address = await client.whoami();
  const start = await client.balance();
  console.log(`agent 钱包: ${address}`);
  console.log(`起始余额 : ${ethers.formatEther(start)} AGP\n`);

  let spent = 0n;

  for (const [i, task] of TASKS.entries()) {
    const res = await client.fetchPaid(ENDPOINT, task);

    if (res.status !== 200) {
      console.log(`[${i + 1}/${TASKS.length}] 失败 HTTP ${res.status}: ${JSON.stringify(res.body)}`);
      continue;
    }

    const price = res.payment?.price ?? 0n;
    spent += price;
    console.log(`[${i + 1}/${TASKS.length}] ${task}`);
    console.log(`        付费 ${ethers.formatEther(price)} AGP  tx=${res.payment?.txHash?.slice(0, 12)}...`);
    console.log(`        输出 ${res.body.output}`);
  }

  const end = await client.balance();
  console.log(`\n本轮共 ${TASKS.length} 次调用`);
  console.log(`花费      : ${ethers.formatEther(spent)} AGP`);
  console.log(`余额变化  : ${ethers.formatEther(start)} -> ${ethers.formatEther(end)}`);
  console.log(`实际扣减  : ${ethers.formatEther(start - end)} AGP`);

  if (start - end !== spent) {
    console.log("注意：扣减与花费不一致，检查是否有其它交易干扰（claim 结算在服务方账户）");
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
