#!/usr/bin/env node
"use strict";

/**
 * 退款路径端到端演示（本地链）
 *
 * 流程：
 *   1. 向网关要一个 challenge
 *   2. 付款（钱进托管），但不消费
 *   3. 用 evm_increaseTime 把链上时间拨过 refundDelay（仅本地节点支持）
 *   4. 付款方调用 refund()，原额退回
 *
 * 注意：这一步会改变本地链的区块时间戳，请在演示最后跑。
 */

const fs = require("node:fs");
const path = require("node:path");
const { ethers } = require("ethers");
const { AgentPayClient } = require("../sdk/agentpay-client");

const ENDPOINT = process.env.ENDPOINT || "http://127.0.0.1:4021/v1/infer";
const RPC_URL = process.env.RPC_URL || "http://127.0.0.1:8545";

// hardhat 默认账户 #1
const DEFAULT_KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
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
if (!fs.existsSync(cfgPath)) throw new Error("找不到 demo/service.json，请先运行 scripts/register-service.js");
const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"));

async function rpc(method, params) {
  const res = await fetch(RPC_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const data = await res.json();
  if (data.error) throw new Error(`${method}: ${JSON.stringify(data.error)}`);
  return data.result;
}

async function main() {
  const client = new AgentPayClient({
    rpcUrl: RPC_URL,
    privateKey: PRIVATE_KEY,
    token: cfg.token,
    agentPay: cfg.agentPay,
    tls: TLS,
  });

  const provider = new ethers.JsonRpcProvider(RPC_URL);
  const wallet = new ethers.Wallet(PRIVATE_KEY, provider);
  const ap = new ethers.Contract(cfg.agentPay, [
    "function refund(bytes32 memo)",
    "function escrows(bytes32 memo) view returns (address,bytes32,uint96,uint96,uint64,uint8)",
  ], wallet);

  const address = await client.whoami();
  const before = await client.balance();
  console.log(`付款方: ${address}`);
  console.log(`起始  : ${ethers.formatEther(before)} AGP\n`);

  // 1. 要 challenge（不消费）
  const first = await client.request(ENDPOINT, "这笔我不消费，等超时退款");
  if (first.status !== 402) throw new Error(`预期 402，实际 ${first.status}`);
  const challenge = first.body.challenge;
  console.log(`[1] challenge: ${challenge.id.slice(0, 18)}...`);

  // 2. 付款进托管
  const payment = await client.payChallenge(challenge);
  console.log(`[2] 付款进托管 tx: ${payment.txHash}`);
  const escrow = await ap.escrows(payment.challengeId);
  console.log(`    托管金额: ${ethers.formatEther(escrow[2])} AGP · state=${escrow[5]}（0=OPEN）`);
  const afterPay = await client.balance();
  console.log(`    付款后余额: ${ethers.formatEther(afterPay)} AGP`);

  // 3. 拨快时间
  console.log(`[3] evm_increaseTime(+2 天)`);
  await rpc("evm_increaseTime", [2 * 24 * 60 * 60]);
  await rpc("evm_mine", []);

  // 4. 退款
  console.log(`[4] refund(${payment.challengeId.slice(0, 18)}...)`);
  const tx = await ap.refund(payment.challengeId);
  const receipt = await tx.wait();
  console.log(`    tx: ${receipt.hash} status=${receipt.status}`);

  const escrow2 = await ap.escrows(payment.challengeId);
  const after = await client.balance();
  console.log(`\n    托管 state=${escrow2[5]}（2=REFUNDED）`);
  console.log(`    付款后 -> 退款后: ${ethers.formatEther(afterPay)} -> ${ethers.formatEther(after)}`);
  console.log(`    退回金额: ${ethers.formatEther(after - afterPay)} AGP（应为 1.0）`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
