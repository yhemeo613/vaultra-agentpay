"use strict";

/**
 * AgentPay 客户端 SDK
 *
 * 给 AI agent 用：拿到 402 -> 自动签 challenge -> 链上付款 -> 带凭证重试，
 * 全程不需要人介入。
 *
 *   const { AgentPayClient } = require("./sdk/agentpay-client");
 *   const client = new AgentPayClient({ rpcUrl, privateKey, token, agentPay });
 *   const res = await client.fetchPaid("http://127.0.0.1:4021/v1/infer", "你的 prompt");
 */

const { ethers } = require("ethers");
const { computeChallengeId } = require("./challenge");
const { PAYMENT_TYPES, typedDataDomain, paymentValue } = require("./signature");
const { requestJson } = require("./http");

const ERC20_ABI = [
  "function approve(address spender, uint256 amount) returns (bool)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function balanceOf(address owner) view returns (uint256)",
  "function decimals() view returns (uint8)",
];

const AGENTPAY_ABI = [
  "function pay(bytes32 id, uint256 calls, bytes32 memo)",
  "function services(bytes32 id) view returns (address provider, uint96 price, string endpoint, bool active)",
];

class AgentPayClient {
  /**
   * @param {object} opts
   * @param {string} [opts.rpcUrl]
   * @param {string} [opts.privateKey]
   * @param {ethers.Signer} [opts.signer]  给已经持有 signer 的场景用
   * @param {string} opts.token            AGP 合约地址
   * @param {string} opts.agentPay         AgentPay 合约地址
   */
  constructor({ rpcUrl, privateKey, signer, token, agentPay, tls = {} }) {
    if (!token || !agentPay) throw new Error("token 和 agentPay 地址必填");

    const provider = signer ? signer.provider : new ethers.JsonRpcProvider(rpcUrl);
    const base = signer || new ethers.Wallet(privateKey, provider);

    // 一笔流程里可能连续发 approve + pay，必须用 NonceManager 管 nonce
    this.baseSigner = base;
    this.signer = new ethers.NonceManager(base);
    this.token = new ethers.Contract(token, ERC20_ABI, this.signer);
    this.agentPay = new ethers.Contract(agentPay, AGENTPAY_ABI, this.signer);
    this.address = null;
    this.chainId = null;

    // TLS / mTLS 选项，原样透传给 http.js
    this.tls = tls || {};
  }

  async whoami() {
    if (!this.address) this.address = await this.signer.getAddress();
    return this.address;
  }

  /** 共享的签名器（NonceManager）。与 payChallenge 同一 nonce 流，避免裸钱包撞 nonce */
  getSigner() {
    return this.signer;
  }

  async balance() {
    return this.token.balanceOf(await this.whoami());
  }

  /** 授权一次，后面所有调用都不用再 approve */
  async ensureAllowance(amount) {
    const owner = await this.whoami();
    const spender = await this.agentPay.getAddress();
    const current = await this.token.allowance(owner, spender);
    if (current >= amount) return false;

    const tx = await this.token.approve(spender, ethers.MaxUint256);
    await tx.wait();
    return true;
  }

  /**
   * 付一次钱，memo 写入 challengeId，并对这个 challenge 做 EIP-712 签名。
   * 签名让服务端能把「谁付的钱」和「谁来取结果」钉在同一个地址上。
   */
  async payChallenge(challenge) {
    const challengeId = computeChallengeId({
      nonce: challenge.nonce,
      serviceId: challenge.serviceId,
      calls: challenge.calls,
      expiresAt: challenge.expiresAt,
      reqHash: challenge.reqHash,
    });

    if (challenge.id && challenge.id.toLowerCase() !== challengeId.toLowerCase()) {
      throw new Error("challengeId 与服务端不一致（两端 computeChallengeId 实现不同步？）");
    }

    const agentPayAddress = await this.agentPay.getAddress();
    if (this.chainId === null) {
      this.chainId = Number((await this.signer.provider.getNetwork()).chainId);
    }

    const signature = await this.baseSigner.signTypedData(
      typedDataDomain({ chainId: this.chainId, agentPay: agentPayAddress }),
      PAYMENT_TYPES,
      paymentValue({
        challengeId,
        serviceId: challenge.serviceId,
        calls: challenge.calls,
        expiresAt: challenge.expiresAt,
        reqHash: challenge.reqHash,
      }),
    );

    const price = BigInt(challenge.price) * BigInt(challenge.calls);
    const approved = await this.ensureAllowance(price);

    const tx = await this.agentPay.pay(challenge.serviceId, challenge.calls, challengeId);
    const receipt = await tx.wait();

    return { challengeId, txHash: receipt.hash, price, approved, signature };
  }

  /** 取出消费 challenge 需要的三个头 */
  headersFor(payment) {
    return {
      "x-payment-tx": payment.txHash,
      "x-payment-challenge": payment.challengeId,
      "x-payment-signature": payment.signature,
    };
  }

  /** 裸请求：GET（payload 进 query）或 POST（payload 进 JSON body），支持 TLS/mTLS */
  async request(url, payload, headers = {}) {
    const target = new URL(url);

    let method = "GET";
    let body;
    let reqHeaders = { ...headers };

    if (payload !== undefined && payload !== null) {
      method = "POST";
      body = JSON.stringify({ prompt: String(payload) });
      reqHeaders["content-type"] = "application/json";
    }

    const res = await requestJson(target.toString(), {
      method,
      headers: reqHeaders,
      body,
      timeoutMs: this.tls.timeoutMs || 20_000,
      tls: {
        ca: this.tls.ca,
        cert: this.tls.cert,
        key: this.tls.key,
        servername: this.tls.servername,
        rejectUnauthorized: this.tls.rejectUnauthorized ?? true,
      },
    });

    return { status: res.status, body: res.body };
  }

  /**
   * 付费调用：402 -> 付款 -> 重试
   * @returns {{status:number, body:object, payment?:{challengeId:string, txHash:string, price:bigint}}}
   */
  async fetchPaid(url, payload) {
    const first = await this.request(url, payload);
    if (first.status !== 402) return first;

    const challenge = first.body.challenge;
    if (!challenge) throw new Error("返回 402 但没有 challenge 字段，服务端版本不匹配？");

    const payment = await this.payChallenge(challenge);

    const retry = await this.request(url, payload, this.headersFor(payment));

    return { ...retry, payment };
  }
}

module.exports = { AgentPayClient };
