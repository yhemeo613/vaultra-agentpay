#!/usr/bin/env node
"use strict";

/**
 * AgentPay 服务商后台管理 API（本地开发用）
 *
 * 职责：
 *   - 服务管理：注册/更新/下线（provider 私钥）
 *   - 托管台账：从链上事件（Paid/Claimed/Refunded/Disputed/Resolved）重建
 *   - 结算：未结算托管一键 claim（provider 私钥）
 *   - 统计：收入 / 退款 / 平台费汇总
 *   - 设置：费率 / 退款窗口 / 财库 / 仲裁人（owner 私钥）
 *
 * 安全：生产环境必须设置 ADMIN_TOKEN（Bearer）；本地演示可不设。
 * 这是管理服务，不是网关，不要直接暴露给公网。
 */

const http = require("node:http");
const { ethers } = require("ethers");

// ------------------------------------------------------------------ env

const PORT = Number(process.env.PORT || 4022);
const RPC_URL = process.env.RPC_URL || "http://127.0.0.1:8545";
const PROVIDER_KEY = process.env.PROVIDER_PRIVATE_KEY || "";
const OWNER_KEY = process.env.OWNER_PRIVATE_KEY || "";
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || "";
const AGENTPAY_ADDRESS = process.env.AGENTPAY_ADDRESS || "";
const TOKEN_ADDRESS = process.env.TOKEN_ADDRESS || "";
const SERVICE_IDS = (process.env.SERVICE_IDS || "infer-v1").split(",").map((s) => s.trim());
const EVENT_START_BLOCK = Number(process.env.EVENT_START_BLOCK || 0);

if (!AGENTPAY_ADDRESS) {
  console.warn("[warn] 未设置 AGENTPAY_ADDRESS，请从部署记录填：deployments/<network>.json 的 agentPay 字段");
}
if (!PROVIDER_KEY && !OWNER_KEY) {
  console.warn("[warn] 未设置 PROVIDER_PRIVATE_KEY / OWNER_PRIVATE_KEY，管理操作将不可用（只读模式）");
}
if (!ADMIN_TOKEN) {
  console.warn("[warn] 未设置 ADMIN_TOKEN，API 处于无鉴权模式（仅限本地开发！）");
}

// ------------------------------------------------------------------ chain

const provider = new ethers.JsonRpcProvider(RPC_URL);
const providerSigner = PROVIDER_KEY ? new ethers.NonceManager(new ethers.Wallet(PROVIDER_KEY, provider)) : null;
const ownerSigner = OWNER_KEY ? new ethers.NonceManager(new ethers.Wallet(OWNER_KEY, provider)) : null;

const ABI = [
  "function services(bytes32 id) view returns (address provider, uint96 price, string endpoint, bool active)",
  "function escrows(bytes32 memo) view returns (address payer, bytes32 serviceId, uint96 amount, uint96 fee, uint64 expiresAt, uint8 state)",
  "function setService(bytes32 id, uint96 price, string endpoint)",
  "function closeService(bytes32 id)",
  "function claim(bytes32 memo)",
  "function setFee(uint16 bps)",
  "function setRefundDelay(uint64 delay)",
  "function setTreasury(address t)",
  "function setArbiter(address a)",
  "function arbiter() view returns (address)",
  "function treasury() view returns (address)",
  "function feeBps() view returns (uint16)",
  "function refundDelay() view returns (uint64)",
];

const agentPay = new ethers.Contract(AGENTPAY_ADDRESS, ABI, provider);

const EVENTS = [
  "event Paid(bytes32 indexed id, address indexed payer, uint256 gross, uint256 fee, bytes32 memo)",
  "event Claimed(bytes32 indexed memo, address indexed provider, uint256 net, uint256 fee)",
  "event Refunded(bytes32 indexed memo, address indexed payer, uint256 amount)",
  "event Disputed(bytes32 indexed memo, address indexed payer)",
  "event Resolved(bytes32 indexed memo, address indexed arbiter, bool toProvider, uint256 amount)",
];
const iface = new ethers.Interface(EVENTS);

const STATE = ["OPEN", "CLAIMED", "REFUNDED", "DISPUTED", "RESOLVED"];

function serviceIdOf(name) {
  return ethers.id(name);
}

async function buildLedger() {
  const latest = await provider.getBlockNumber();
  const from = Math.max(EVENT_START_BLOCK, 0);
  const events = [];

  // 一次拉全量日志，再用接口逐条分类。
  // 说明：部分节点（含 hardhat 本地节点）的 topics 过滤不可靠，
  // 且 ethers v6 的 getEvent().topic 在某些接口构造方式下为 undefined，
  // 所以统一用 parseLog 的 name 分类——真实链上同样正确，
  // 代价是从 EVENT_START_BLOCK 起全量扫描。
  const logs = await provider.getLogs({ address: AGENTPAY_ADDRESS, fromBlock: from, toBlock: "latest" });

  for (const l of logs) {
    const parsed = iface.parseLog(l);
    if (!parsed) continue; // ServiceSet / OwnershipTransferred 等不在台账口径里
    events.push({ name: parsed.name, block: l.blockNumber, tx: l.transactionHash, args: parsed.args });
  }

  events.sort((a, b) => a.block - b.block);
  return { events, latest, from };
}

// ------------------------------------------------------------------ helpers

function send(res, status, body) {
  const data = JSON.stringify(body, null, 2);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(data),
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-allow-headers": "content-type,authorization",
    "cache-control": "no-store",
  });
  res.end(data);
}

function auth(req, res) {
  if (!ADMIN_TOKEN) return true;
  const header = req.headers.authorization || "";
  if (header !== "Bearer " + ADMIN_TOKEN) {
    send(res, 401, { error: "unauthorized" });
    return false;
  }
  return true;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

async function parseJson(req) {
  const raw = await readBody(req);
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

// ------------------------------------------------------------------ routes

async function handler(req, res) {
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "GET,POST,OPTIONS",
      "access-control-allow-headers": "content-type,authorization",
    });
    return res.end();
  }

  const url = new URL(req.url, "http://localhost");
  const path = url.pathname;

  if (path === "/api/status") {
    if (!auth(req, res)) return;
    const [chainId, block, feeBps, refundDelay, treasury, arbiter] = await Promise.all([
      provider.getNetwork().then((n) => Number(n.chainId)),
      provider.getBlockNumber(),
      agentPay.feeBps().catch(() => 0),
      agentPay.refundDelay().catch(() => 0),
      agentPay.treasury().catch(() => ethers.ZeroAddress),
      agentPay.arbiter().catch(() => ethers.ZeroAddress),
    ]);
    return send(res, 200, {
      ok: true,
      chainId,
      block,
      agentPay: AGENTPAY_ADDRESS,
      token: TOKEN_ADDRESS,
      provider: providerSigner ? await providerSigner.getAddress() : null,
      owner: ownerSigner ? await ownerSigner.getAddress() : null,
      feeBps: Number(feeBps),
      refundDelay: Number(refundDelay),
      treasury,
      arbiter,
      readonly: !providerSigner,
    });
  }

  if (path === "/api/services") {
    if (!auth(req, res)) return;
    const list = [];
    for (const name of SERVICE_IDS) {
      const id = serviceIdOf(name);
      const s = await agentPay.services(id);
      list.push({ id, name, provider: s.provider, price: s.price.toString(), endpoint: s.endpoint, active: s.active });
    }
    return send(res, 200, { services: list });
  }

  if (path === "/api/services" && req.method === "POST") {
    if (!auth(req, res) || !providerSigner) return send(res, 403, { error: "provider key 未配置" });
    const body = await parseJson(req);
    const id = serviceIdOf(body.id || "infer-v1");
    const price = ethers.parseEther(String(body.price ?? 1));
    const endpoint = String(body.endpoint || "http://127.0.0.1:4021/v1/infer");
    const tx = await agentPay.connect(providerSigner).setService(id, price, endpoint);
    await tx.wait();
    return send(res, 200, { ok: true, tx: tx.hash });
  }

  if (path === "/api/services/close" && req.method === "POST") {
    if (!auth(req, res) || !providerSigner) return send(res, 403, { error: "provider key 未配置" });
    const body = await parseJson(req);
    const id = serviceIdOf(body.id || "infer-v1");
    const tx = await agentPay.connect(providerSigner).closeService(id);
    await tx.wait();
    return send(res, 200, { ok: true, tx: tx.hash });
  }

  if (path === "/api/escrows") {
    if (!auth(req, res)) return;
    const { events, latest, from } = await buildLedger();

    // 重建每个 memo 的台账：payer、金额、fee、当前状态、相关交易
    const escrows = [];
    const byMemo = new Map();
    for (const e of events) {
      if (!byMemo.has(e.args.memo)) byMemo.set(e.args.memo, { events: [] });
      byMemo.get(e.args.memo).events.push(e);
    }
    for (const [memo, entry] of byMemo) {
      const evs = entry.events;
      const paid = evs.find((e) => e.name === "Paid");
      if (!paid) continue;
      const claimed = evs.find((e) => e.name === "Claimed");
      const refunded = evs.find((e) => e.name === "Refunded");
      const disputed = evs.find((e) => e.name === "Disputed");
      const resolved = evs.find((e) => e.name === "Resolved");
      const state = claimed ? "CLAIMED" : refunded ? "REFUNDED" : resolved ? "RESOLVED" : disputed ? "DISPUTED" : "OPEN";
      escrows.push({
        memo,
        payer: paid.args.payer,
        serviceId: paid.args.id,
        amount: paid.args.gross.toString(),
        fee: paid.args.fee.toString(),
        state,
        paidTx: paid.tx,
        settledTx: (claimed || refunded || resolved)?.tx || null,
        block: paid.block,
        resolvedToProvider: resolved ? Boolean(resolved.args.toProvider) : null,
      });
    }
    escrows.sort((a, b) => b.block - a.block);
    return send(res, 200, { escrows, latest, from, scanned: latest - from + 1 });
  }

  if (path === "/api/escrows/claim" && req.method === "POST") {
    if (!auth(req, res) || !providerSigner) return send(res, 403, { error: "provider key 未配置" });
    const body = await parseJson(req);
    const memo = String(body.memo || "");
    if (!/^0x[0-9a-fA-F]{64}$/.test(memo)) return send(res, 400, { error: "memo 格式不对" });
    const escrow = await agentPay.escrows(memo);
    if (Number(escrow.state) !== 0) return send(res, 400, { error: "托管不在 OPEN 状态", state: STATE[Number(escrow.state)] });
    const tx = await agentPay.connect(providerSigner).claim(memo);
    await tx.wait();
    return send(res, 200, { ok: true, tx: tx.hash, memo });
  }

  if (path === "/api/stats") {
    if (!auth(req, res)) return;
    const { events } = await buildLedger();
    const stats = {
      paid: 0n, claimedNet: 0n, fees: 0n, refunded: 0n,
      counts: { paid: 0, claimed: 0, refunded: 0, disputed: 0, resolved: 0 },
    };
    for (const e of events) {
      if (e.name === "Paid") { stats.paid += e.args.gross; stats.counts.paid++; }
      if (e.name === "Claimed") { stats.claimedNet += e.args.net; stats.fees += e.args.fee; stats.counts.claimed++; }
      if (e.name === "Refunded") { stats.refunded += e.args.amount; stats.counts.refunded++; }
      if (e.name === "Disputed") stats.counts.disputed++;
      if (e.name === "Resolved") stats.counts.resolved++;
    }
    return send(res, 200, {
      paid: stats.paid.toString(),
      claimedNet: stats.claimedNet.toString(),
      fees: stats.fees.toString(),
      refunded: stats.refunded.toString(),
      counts: stats.counts,
    });
  }

  if (path === "/api/settings" && req.method === "POST") {
    if (!auth(req, res) || !ownerSigner) return send(res, 403, { error: "owner key 未配置" });
    const body = await parseJson(req);
    let tx;
    switch (body.action) {
      case "fee": {
        const bps = Number(body.value);
        if (!Number.isInteger(bps) || bps < 0 || bps > 500) return send(res, 400, { error: "fee 必须是 0–500 bps（≤5%）" });
        tx = await agentPay.connect(ownerSigner).setFee(bps);
        break;
      }
      case "refundDelay": {
        const sec = Number(body.value);
        if (!Number.isInteger(sec) || sec < 3600 || sec > 2592000) return send(res, 400, { error: "refundDelay 必须在 1h–30d（秒）" });
        tx = await agentPay.connect(ownerSigner).setRefundDelay(sec);
        break;
      }
      case "treasury": {
        const addr = String(body.value || "");
        if (!ethers.isAddress(addr)) return send(res, 400, { error: "地址格式不对" });
        tx = await agentPay.connect(ownerSigner).setTreasury(addr);
        break;
      }
      case "arbiter": {
        const addr = String(body.value || "");
        if (!ethers.isAddress(addr)) return send(res, 400, { error: "地址格式不对" });
        tx = await agentPay.connect(ownerSigner).setArbiter(addr);
        break;
      }
      default:
        return send(res, 400, { error: "未知 action: fee / refundDelay / treasury / arbiter" });
    }
    await tx.wait();
    return send(res, 200, { ok: true, tx: tx.hash });
  }

  return send(res, 404, { error: "not_found" });
}

const server = http.createServer((req, res) => {
  handler(req, res).catch((error) => {
    console.error("[admin error]", error.message);
    if (!res.headersSent) send(res, 500, { error: "internal_error", message: error.message });
    else res.end();
  });
});

server.listen(PORT, () => {
  console.log(`AgentPay 服务商后台 API listening on http://127.0.0.1:${PORT}`);
  console.log(`  agentPay   : ${AGENTPAY_ADDRESS || "(未配置)"}`);
  console.log(`  provider   : ${providerSigner ? "(已配置)" : "(未配置，只读)"}`);
  console.log(`  owner      : ${ownerSigner ? "(已配置)" : "(未配置)"}`);
  console.log(`  services   : ${SERVICE_IDS.join(", ")}`);
  console.log(`  auth       : ${ADMIN_TOKEN ? "Bearer token" : "无鉴权（仅本地！）"}`);
});
