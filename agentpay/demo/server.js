#!/usr/bin/env node
"use strict";

/**
 * AgentPay 计费网关 v3
 *
 * 相比 v2 补上了四件事：
 *   1) 传输层：支持 HTTPS，可强制 TLS（REQUIRE_TLS=1），可要求客户端证书（mTLS），
 *      并把 challenge 绑定到「请求方身份」（mTLS 指纹 / IP+UA），身份不符时不消耗 challenge。
 *   2) 状态存储：challenge 不再放进程内存，走 store（memory / sqlite / redis），
 *      重启不丢、多实例共享。
 *   3) 结算：付款进入链上托管，交付成功后由服务方 claim；超时未交付，付款方可 refund。
 *   4) 推理：接 OpenAI 兼容接口，没配置时回退 mock。
 *
 * 仍然是「一次付款 = 一次请求」：challenge 单次核销 + 绑定请求指纹 + EIP-712 签名。
 */

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const http = require("node:http");
const https = require("node:https");
const { ethers } = require("ethers");

const { CHALLENGE_TTL_SECONDS, requestHash, computeChallengeId, newNonce } = require("../sdk/challenge");
const { recoverPaymentSigner } = require("../sdk/signature");
const { infer } = require("../sdk/inference");
const { createStore } = require("../store");

const ROUTE = "/v1/infer";

// 读取请求体（POST）；GET 没有 body
function readBody(req) {
  return new Promise((resolve, reject) => {
    if (req.method !== "POST") return resolve("");
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

/** 从请求里提取 prompt：GET ?prompt=，POST {prompt} 或裸文本 */
function extractPrompt(req, url, rawBody) {
  if (req.method === "GET") return url.searchParams.get("prompt") || "";
  if (!rawBody) return "";
  const trimmed = rawBody.trim();
  if (trimmed.startsWith("{")) {
    try {
      const parsed = JSON.parse(trimmed);
      return String(parsed.prompt ?? parsed.input ?? "");
    } catch {
      return "";
    }
  }
  return trimmed;
}

// ------------------------------------------------------------------ config

function loadServiceConfig() {
  const file = path.join(__dirname, "service.json");
  const base = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : {};

  const cfg = {
    agentPay: process.env.AGENTPAY_ADDRESS || base.agentPay,
    token: process.env.TOKEN_ADDRESS || base.token,
    serviceId: process.env.SERVICE_ID || base.serviceId,
    price: process.env.PRICE || base.price,
    chainId: Number(process.env.CHAIN_ID || base.chainId || 31337),
  };

  for (const [key, value] of Object.entries(cfg)) {
    if (value === undefined || value === null || value === "") {
      throw new Error(`缺少配置项 ${key}：请先运行 scripts/register-service.js，或用环境变量提供`);
    }
  }
  cfg.price = BigInt(cfg.price).toString();
  return cfg;
}

const cfg = loadServiceConfig();

const PORT = Number(process.env.PORT || 4021);
const RPC_URL = process.env.RPC_URL || "http://127.0.0.1:8545";
const CHALLENGE_TTL = Number(process.env.CHALLENGE_TTL_SECONDS || CHALLENGE_TTL_SECONDS);
const REQUIRE_TLS = process.env.REQUIRE_TLS === "1";
const TRUST_PROXY = process.env.TRUST_PROXY === "1";
const BIND_CLIENT = process.env.BIND_CLIENT !== "0";
const REQUIRE_CLIENT_CERT = process.env.TLS_REQUIRE_CLIENT_CERT === "1";

const TLS_CERT = process.env.TLS_CERT || "";
const TLS_KEY = process.env.TLS_KEY || "";
const TLS_CA = process.env.TLS_CA || "";

const LLM = {
  baseUrl: process.env.LLM_BASE_URL || "",
  apiKey: process.env.LLM_API_KEY || "",
  model: process.env.LLM_MODEL || "gpt-4o-mini",
  timeoutMs: Number(process.env.LLM_TIMEOUT_MS || 25_000),
};

const STORE_KIND = process.env.STORE || (process.env.REDIS_URL ? "redis" : "memory");
const store = createStore({
  kind: STORE_KIND,
  file: process.env.STORE_FILE || path.join(__dirname, "..", "agentpay.db"),
  url: process.env.REDIS_URL || "redis://127.0.0.1:6379",
});

// ------------------------------------------------------------------ chain

const provider = new ethers.JsonRpcProvider(RPC_URL);
const paidIface = new ethers.Interface([
  "event Paid(bytes32 indexed id, address indexed payer, uint256 gross, uint256 fee, bytes32 memo)",
]);

const agentPay = new ethers.Contract(
  cfg.agentPay,
  [
    "function claim(bytes32 memo)",
    "function escrows(bytes32 memo) view returns (address payer, bytes32 serviceId, uint96 amount, uint96 fee, uint64 expiresAt, uint8 state)",
  ],
  provider,
);

/** 服务方结算钱包私钥（每次 claim 用全新 Wallet + 实时 nonce，见 settleEscrow） */
const PROVIDER_PRIVATE_KEY = process.env.PROVIDER_PRIVATE_KEY || "";

// ------------------------------------------------------------------ helpers

function send(res, status, body) {
  const data = JSON.stringify(body, null, 2);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(data),
    "cache-control": "no-store",
    "x-payment-required": status === 402 ? "true" : "false",
    // 本地演示页（demo.html）从站点跨源调用需要 CORS；
    // 生产网关应去掉这一行，改由同源前端或网关自身的 CORS 白名单控制
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-allow-headers": "content-type,x-payment-tx,x-payment-challenge,x-payment-signature",
  });
  res.end(data);
}

function isSecure(req) {
  if (req.socket.encrypted) return true;
  if (TRUST_PROXY) {
    const proto = String(req.headers["x-forwarded-proto"] || "").split(",")[0].trim().toLowerCase();
    if (proto === "https") return true;
  }
  return false;
}

function peerCertificate(req) {
  const socket = req.socket;
  if (!socket.encrypted || typeof socket.getPeerCertificate !== "function") return null;
  const cert = socket.getPeerCertificate();
  return cert && cert.fingerprint256 ? cert : null;
}

/**
 * 请求方身份。有 mTLS 就用证书指纹（密码学身份），
 * 否则退化为 IP + UA 摘要（够挡住「从别处截获报文再重放」）。
 */
function clientIdentity(req, peer) {
  if (peer) return `mtls:${peer.fingerprint256}`;
  const rawIp = TRUST_PROXY
    ? String(req.headers["x-forwarded-for"] || "").split(",")[0].trim() || req.socket.remoteAddress
    : req.socket.remoteAddress;
  const ua = String(req.headers["user-agent"] || "").slice(0, 160);
  const uaHash = crypto.createHash("sha256").update(ua).digest("hex").slice(0, 16);
  return `net:${rawIp}|${uaHash}`;
}

async function issueChallenge(reqHash, identity) {
  const nowSec = Math.floor(Date.now() / 1000);
  const challenge = {
    nonce: newNonce(),
    serviceId: cfg.serviceId,
    calls: 1,
    price: cfg.price,
    expiresAt: nowSec + CHALLENGE_TTL,
    reqHash,
  };
  const id = computeChallengeId(challenge);

  await store.set(
    `challenge:${id}`,
    JSON.stringify({
      reqHash,
      serviceId: cfg.serviceId,
      calls: challenge.calls,
      price: cfg.price,
      expiresAt: challenge.expiresAt,
      identity,
      used: false,
    }),
    CHALLENGE_TTL * 1000 + 5_000,
  );

  return { id, ...challenge };
}

async function loadChallenge(id) {
  const raw = await store.get(`challenge:${id}`);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function markUsed(id, record) {
  const ttl = Math.max(1, record.expiresAt * 1000 - Date.now());
  await store.set(`challenge:${id}`, JSON.stringify({ ...record, used: true }), ttl);
}

async function verifyOnChain(txHash, challengeId) {
  if (!/^0x[0-9a-fA-F]{64}$/.test(txHash)) {
    return { ok: false, reason: "tx hash 格式不对" };
  }

  let receipt;
  try {
    receipt = await provider.getTransactionReceipt(txHash.toLowerCase());
  } catch {
    return { ok: false, reason: "RPC 查询失败" };
  }
  if (!receipt) return { ok: false, reason: "链上查不到这笔交易，或还在 pending" };
  if (receipt.status !== 1) return { ok: false, reason: "交易执行失败（reverted）" };
  if (!receipt.to || receipt.to.toLowerCase() !== cfg.agentPay.toLowerCase()) {
    return { ok: false, reason: "交易目标不是 AgentPay 合约" };
  }

  const want = BigInt(cfg.price);
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== cfg.agentPay.toLowerCase()) continue;

    let parsed = null;
    try {
      parsed = paidIface.parseLog(log);
    } catch {
      continue;
    }
    if (!parsed || parsed.name !== "Paid") continue;
    if (parsed.args.id.toLowerCase() !== cfg.serviceId.toLowerCase()) continue;
    if (parsed.args.memo.toLowerCase() !== challengeId.toLowerCase()) continue;
    if (parsed.args.gross < want) continue;

    return { ok: true, payer: parsed.args.payer, gross: parsed.args.gross, fee: parsed.args.fee };
  }

  return { ok: false, reason: "交易里没有 memo == challengeId 且金额足够的 Paid 事件" };
}

/** 交付成功后结算托管；用 store.setNx 做分布式锁，多实例不会重复 claim */
async function settleEscrow(memo, challengeId) {
  if (!PROVIDER_PRIVATE_KEY) return "pending";

  // 抢 60s 的结算锁；抢不到说明别的实例正在结算，等它完成即可
  const locked = await store.setNx(`claim-lock:${memo}`, String(Date.now()), 60_000);
  if (!locked) return "pending";

  // 注意：每次 claim 都用一个全新 Wallet + 链上实时 nonce。
  // 原因：进程内 NonceManager 在多进程共享同一把私钥时会撞 nonce
  // （本机就有网关 + 后台管理两个进程共用服务方钱包）。
  // 生产环境应改为单一签名者（KMS/签名服务），此处用实时 nonce + 一次重试兜底。
  const wallet = new ethers.Wallet(PROVIDER_PRIVATE_KEY, provider);

  async function attempt() {
    const escrow = await agentPay.escrows(memo);
    if (escrow.state !== 0n) return "already_settled"; // OPEN=0
    const nonce = await provider.getTransactionCount(wallet.address);
    const tx = await agentPay.connect(wallet).claim(memo, { nonce });
    await tx.wait();
    return "claimed";
  }

  try {
    const result = await attempt();
    if (result === "claimed") {
      console.log(`[settle] claimed memo=${challengeId.slice(0, 12)}…`);
    }
    return result;
  } catch (error) {
    const msg = error.shortMessage || error.message || "";
    if (msg.includes("nonce")) {
      // 与其它进程撞了 nonce：等一拍用最新 nonce 重试一次
      await new Promise((r) => setTimeout(r, 700));
      try {
        const result = await attempt();
        if (result === "claimed") console.log(`[settle] retry claimed memo=${challengeId.slice(0, 12)}…`);
        return result;
      } catch (e2) {
        console.warn(`[settle] 重试仍失败 memo=${challengeId.slice(0, 12)}…: ${e2.shortMessage || e2.message}`);
        return "failed";
      }
    }
    console.warn(`[settle] claim 失败 memo=${challengeId.slice(0, 12)}…: ${msg}`);
    return "failed";
  }
}

// ------------------------------------------------------------------ server

async function handle(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);

  if (url.pathname === "/health") {
    return send(res, 200, {
      ok: true,
      chainId: cfg.chainId,
      agentPay: cfg.agentPay,
      store: STORE_KIND,
      tls: Boolean(req.socket.encrypted),
      requireTls: REQUIRE_TLS,
      bindClient: BIND_CLIENT,
      inference: LLM.baseUrl ? "upstream" : "mock",
      settlement: PROVIDER_PRIVATE_KEY ? "auto" : "manual",
    });
  }

  if (url.pathname !== ROUTE) return send(res, 404, { error: "not_found" });
  if (req.method !== "GET" && req.method !== "POST") return send(res, 405, { error: "method_not_allowed" });

  // ---- 传输层要求 ----
  if (REQUIRE_TLS && !isSecure(req)) {
    return send(res, 426, {
      error: "tls_required",
      reason: "本服务要求 HTTPS。请通过 TLS 访问，或在前置代理上透传 X-Forwarded-Proto=https。",
    });
  }

  const peer = peerCertificate(req);
  if (REQUIRE_CLIENT_CERT && !peer) {
    return send(res, 403, { error: "client_cert_required", reason: "需要 mTLS 客户端证书" });
  }

  const identity = clientIdentity(req, peer);

  const rawBody = await readBody(req);
  const prompt = extractPrompt(req, url, rawBody) || "";
  const reqHash = requestHash(req.method, ROUTE, prompt);

  const txHash = req.headers["x-payment-tx"];
  const challengeId = req.headers["x-payment-challenge"];

  // ---- 未付款：签发 challenge ----
  if (!txHash) {
    const challenge = await issueChallenge(reqHash, identity);
    return send(res, 402, {
      error: "payment_required",
      scheme: "agentpay-bep20-challenge",
      chainId: cfg.chainId,
      asset: cfg.token,
      payTo: cfg.agentPay,
      challenge,
      howto: [
        "1. 用 sdk/challenge.js 的 computeChallengeId(challenge) 算出 challengeId",
        `2. approve(${cfg.agentPay}, ${cfg.price})`,
        "3. AgentPay.pay(serviceId, calls, challengeId)   // challengeId 作为 memo，资金进托管",
        "4. 用 sdk/signature.js 对 challengeId 做 EIP-712 签名",
        "5. 带 X-PAYMENT-TX / X-PAYMENT-CHALLENGE / X-PAYMENT-SIGNATURE 重试本请求",
      ],
      note: "同一 challenge 只能消费一次，且只对签发它的客户端有效",
    });
  }

  if (!challengeId) {
    return send(res, 402, { error: "invalid_payment", reason: "缺少 X-PAYMENT-CHALLENGE 头" });
  }

  const record = await loadChallenge(String(challengeId));
  if (!record) {
    return send(res, 402, { error: "invalid_payment", reason: "challenge 不存在（已过期或伪造）" });
  }
  if (record.used) {
    return send(res, 402, { error: "invalid_payment", reason: "challenge 已被核销（防重放）" });
  }
  if (record.expiresAt < Math.floor(Date.now() / 1000)) {
    return send(res, 402, { error: "invalid_payment", reason: `challenge 已过期（有效期 ${CHALLENGE_TTL}s）` });
  }

  // 身份不符时拒绝，但不消耗 challenge —— 真正的付款人仍可继续
  if (BIND_CLIENT && record.identity !== identity) {
    return send(res, 403, {
      error: "client_mismatch",
      reason: "这次 challenge 是签发给另一个客户端身份的，不能跨客户端使用",
    });
  }

  if (record.reqHash !== reqHash) {
    return send(res, 402, { error: "invalid_payment", reason: "这笔付款绑定的是另一个请求（prompt 不同），不能挪用" });
  }

  const signature = req.headers["x-payment-signature"];
  if (!signature) {
    return send(res, 402, { error: "invalid_payment", reason: "缺少 X-PAYMENT-SIGNATURE 头（EIP-712 签名）" });
  }

  let signer;
  try {
    signer = recoverPaymentSigner(String(signature), {
      chainId: cfg.chainId,
      agentPay: cfg.agentPay,
      challengeId: String(challengeId),
      serviceId: record.serviceId,
      calls: record.calls,
      expiresAt: record.expiresAt,
      reqHash: record.reqHash,
    });
  } catch {
    return send(res, 402, { error: "invalid_payment", reason: "EIP-712 签名格式无效" });
  }

  const verdict = await verifyOnChain(String(txHash), String(challengeId));
  if (!verdict.ok) {
    return send(res, 402, { error: "invalid_payment", reason: verdict.reason, price: cfg.price });
  }

  if (signer.toLowerCase() !== verdict.payer.toLowerCase()) {
    return send(res, 402, {
      error: "invalid_payment",
      reason: `签名者 ${signer} 与链上付款人 ${verdict.payer} 不一致`,
    });
  }

  // ---- 消费 challenge，然后交付 ----
  await markUsed(String(challengeId), record);

  let result;
  try {
    result = await infer(prompt, LLM);
  } catch (error) {
    // 上游失败就不吞掉这次付款：把 challenge 恢复成可用，付款方可重试或到期退款
    await store.set(
      `challenge:${challengeId}`,
      JSON.stringify({ ...record, used: false }),
      Math.max(1, record.expiresAt * 1000 - Date.now()),
    );
    return send(res, 502, { error: "upstream_failed", reason: error.message, retryable: true });
  }

  const settlement = await settleEscrow(String(challengeId), String(challengeId));

  return send(res, 200, {
    ok: true,
    model: result.model,
    mock: result.mock,
    prompt,
    output: result.text,
    usage: result.usage,
    billing: {
      tx: txHash,
      challengeId,
      signer,
      payer: verdict.payer,
      gross: verdict.gross.toString(),
      fee: verdict.fee.toString(),
      serviceId: cfg.serviceId,
      settlement,
    },
  });
}

function createServer() {
  const tlsEnabled = Boolean(TLS_CERT && TLS_KEY);

  const listener = (req, res) => {
    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        "access-control-allow-origin": "*",
        "access-control-allow-methods": "GET,POST,OPTIONS",
        "access-control-allow-headers": "content-type,x-payment-tx,x-payment-challenge,x-payment-signature",
      });
      return res.end();
    }
    handle(req, res).catch((error) => {
      console.error("[error]", error);
      if (!res.headersSent) send(res, 500, { error: "internal_error", message: error.message });
      else res.end();
    });
  };

  if (!tlsEnabled) return { server: http.createServer(listener), protocol: "http" };

  const options = {
    cert: fs.readFileSync(TLS_CERT),
    key: fs.readFileSync(TLS_KEY),
    requestCert: REQUIRE_CLIENT_CERT || process.env.TLS_REQUEST_CLIENT_CERT === "1",
    // 自签名客户端证书链无法自动校验，改由 handler 校验指纹/存在性
    rejectUnauthorized: false,
  };
  if (TLS_CA) options.ca = fs.readFileSync(TLS_CA);

  return { server: https.createServer(options, listener), protocol: "https" };
}

const { server, protocol } = createServer();

server.listen(PORT, () => {
  console.log(`AgentPay gateway (${protocol}) listening on ${protocol}://127.0.0.1:${PORT}`);
  console.log(`  rpc        : ${RPC_URL}`);
  console.log(`  agentPay   : ${cfg.agentPay}`);
  console.log(`  token      : ${cfg.token}`);
  console.log(`  serviceId  : ${cfg.serviceId}`);
  console.log(`  price/call : ${ethers.formatEther(cfg.price)} AGP`);
  console.log(`  store      : ${STORE_KIND}`);
  console.log(`  challenge  : TTL ${CHALLENGE_TTL}s · bindClient=${BIND_CLIENT} · requireTls=${REQUIRE_TLS}`);
  console.log(`  inference  : ${LLM.baseUrl ? LLM.baseUrl : "mock（未配置 LLM_BASE_URL）"}`);
  console.log(`  settlement : ${PROVIDER_PRIVATE_KEY ? "交付后自动 claim" : "未配置 PROVIDER_PRIVATE_KEY，需手动 claim"}`);
});

async function shutdown(signal) {
  console.log(`\n[${signal}] 关闭中…`);
  server.close();
  try {
    await store.close?.();
  } catch {
    /* ignore */
  }
  process.exit(0);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
