#!/usr/bin/env node
"use strict";

/**
 * 单次调用 + 五种攻击面演示（v3，含 escrow 结算）
 *
 *   [3] 换一把私钥签名                   -> 应被拒（签名者 ≠ 付款人）
 *   [4] 拿这笔付款去请求另一个 prompt     -> 应被拒（challenge 绑定请求指纹）
 *   [5] 用另一个客户端身份消费            -> 应被拒（challenge 绑定客户端身份，且不消耗）
 *   [7] 成功后原样重放                   -> 应被拒（challenge 一次性）
 *   [8] 未配 mTLS 证书直接访问            -> 应被拒（若服务端开了 REQUIRE_CLIENT_CERT）
 */

const fs = require("node:fs");
const path = require("node:path");
const { ethers } = require("ethers");
const { AgentPayClient } = require("../sdk/agentpay-client");
const { signPayment } = require("../sdk/signature");

const ENDPOINT = process.env.ENDPOINT || "http://127.0.0.1:4021/v1/infer";
const RPC_URL = process.env.RPC_URL || "http://127.0.0.1:8545";

// hardhat 默认账户 #1 的私钥，仅本地链有意义；测试网请用环境变量传自己的测试钱包
const DEFAULT_KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
const PRIVATE_KEY = process.env.PRIVATE_KEY || DEFAULT_KEY;

// TLS / mTLS：指向 scripts/make-certs.js 生成的证书
const CERTS_DIR = path.join(__dirname, "..", "certs");
const TLS = {
  ca: fs.existsSync(path.join(CERTS_DIR, "server.crt")) ? fs.readFileSync(path.join(CERTS_DIR, "server.crt")) : undefined,
  cert: fs.existsSync(path.join(CERTS_DIR, "client.crt")) ? fs.readFileSync(path.join(CERTS_DIR, "client.crt")) : undefined,
  key: fs.existsSync(path.join(CERTS_DIR, "client.key")) ? fs.readFileSync(path.join(CERTS_DIR, "client.key")) : undefined,
  rejectUnauthorized: false, // 自签名证书：信任我们的 CA 文件
  servername: "localhost",
};

const cfgPath = path.join(__dirname, "service.json");
if (!fs.existsSync(cfgPath)) {
  throw new Error("找不到 demo/service.json，请先运行 scripts/register-service.js");
}
const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"));

function newClient(privateKey, tlsOverrides = {}) {
  return new AgentPayClient({
    rpcUrl: RPC_URL,
    privateKey,
    token: cfg.token,
    agentPay: cfg.agentPay,
    tls: { ...TLS, ...tlsOverrides },
  });
}

async function main() {
  const prompt = process.argv[2] || "为什么 BSC 适合做 agent 微支付";

  const client = newClient(PRIVATE_KEY);

  const address = await client.whoami();
  console.log(`钱包: ${address}`);
  console.log(`AGP 余额: ${ethers.formatEther(await client.balance())}\n`);

  const first = await client.request(ENDPOINT, prompt);
  const challenge = first.body.challenge;
  console.log(`[1] 未付款请求 -> HTTP ${first.status}`);
  console.log(`    challenge : ${challenge.id}`);
  console.log(`    请求指纹  : ${challenge.reqHash}`);
  console.log(`    过期时间  : ${challenge.expiresAt}`);

  const payment = await client.payChallenge(challenge);
  console.log(`\n[2] 付款（资金进托管）并签名`);
  console.log(`    tx        : ${payment.txHash}`);
  console.log(`    memo      : ${payment.challengeId}`);
  console.log(`    signature : ${payment.signature.slice(0, 26)}...`);

  // 攻击 1：用另一把私钥签同一个 challenge
  const attacker = ethers.Wallet.createRandom();
  const forged = await signPayment(attacker, {
    chainId: cfg.chainId,
    agentPay: cfg.agentPay,
    challengeId: payment.challengeId,
    serviceId: challenge.serviceId,
    calls: challenge.calls,
    expiresAt: challenge.expiresAt,
    reqHash: challenge.reqHash,
  });
  const forgedRes = await client.request(ENDPOINT, prompt, {
    "x-payment-tx": payment.txHash,
    "x-payment-challenge": payment.challengeId,
    "x-payment-signature": forged,
  });
  console.log(`\n[3] 换一把私钥签名 -> HTTP ${forgedRes.status}`);
  console.log(`    ${forgedRes.body.reason ?? "（竟然通过了，验签有 bug）"}`);

  // 攻击 2：拿这笔付款去请求另一个 prompt
  const stolen = await client.request(ENDPOINT, "换一个 prompt 试试能不能白嫖", client.headersFor(payment));
  console.log(`\n[4] 拿这笔付款去请求另一个 prompt -> HTTP ${stolen.status}`);
  console.log(`    ${stolen.body.reason ?? "（竟然通过了，绑定逻辑有 bug）"}`);

  // 攻击 3：换一个客户端身份（不带 mTLS 证书，走 IP+UA 身份）消费同一笔付款
  const bareClient = newClient(PRIVATE_KEY, {
    cert: undefined,
    key: undefined,
  });
  const differentUa = await bareClient.request(ENDPOINT, prompt, {
    ...client.headersFor(payment),
    "user-agent": "someone-else-agent",
  });
  console.log(`\n[5] 用另一个客户端身份消费 -> HTTP ${differentUa.status}`);
  console.log(`    ${differentUa.body.reason ?? "（竟然通过了，客户端绑定有 bug）"}`);

  // 正常消费
  const paid = await client.request(ENDPOINT, prompt, client.headersFor(payment));
  console.log(`\n[6] 正确请求原 prompt -> HTTP ${paid.status}`);
  console.log(JSON.stringify(paid.body, null, 2));

  // 攻击 4：重放
  const replay = await client.request(ENDPOINT, prompt, client.headersFor(payment));
  console.log(`\n[7] 原样重放 -> HTTP ${replay.status}`);
  console.log(`    ${replay.body.reason ?? "（竟然通过了，防重放有 bug）"}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
