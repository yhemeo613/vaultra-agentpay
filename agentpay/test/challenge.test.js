const { expect } = require("chai");
const { ethers } = require("hardhat");
const { requestHash, computeChallengeId, newNonce } = require("../sdk/challenge");
const { signPayment, recoverPaymentSigner } = require("../sdk/signature");

const BASE = {
  nonce: ethers.id("fixed-nonce"),
  serviceId: ethers.id("infer-v1"),
  calls: 1,
  expiresAt: 1_800_000_000,
  reqHash: requestHash("GET", "/v1/infer", "hello"),
};

describe("challenge 协议", function () {
  it("requestHash 对同样输入稳定", function () {
    expect(requestHash("GET", "/v1/infer", "hello")).to.equal(requestHash("get", "/v1/infer", "hello"));
  });

  it("prompt 变了，requestHash 就变", function () {
    const a = requestHash("GET", "/v1/infer", "hello");
    const b = requestHash("GET", "/v1/infer", "hello!");
    expect(a).to.not.equal(b);
  });

  it("computeChallengeId 对同样输入稳定，且是 32 字节", function () {
    const a = computeChallengeId(BASE);
    const b = computeChallengeId({ ...BASE });
    expect(a).to.equal(b);
    expect(a).to.match(/^0x[0-9a-f]{64}$/);
  });

  it("换 prompt 会得到不同的 challengeId（付款无法挪用）", function () {
    const a = computeChallengeId(BASE);
    const b = computeChallengeId({ ...BASE, reqHash: requestHash("GET", "/v1/infer", "另一个问题") });
    expect(a).to.not.equal(b);
  });

  it("换 nonce 会得到不同的 challengeId（每次签发唯一）", function () {
    const a = computeChallengeId(BASE);
    const b = computeChallengeId({ ...BASE, nonce: newNonce() });
    expect(a).to.not.equal(b);
  });

  it("过期时间参与计算，改时间戳也会变 id", function () {
    const a = computeChallengeId(BASE);
    const b = computeChallengeId({ ...BASE, expiresAt: BASE.expiresAt + 1 });
    expect(a).to.not.equal(b);
  });
});

describe("EIP-712 付款签名", function () {
  const AGENTPAY = "0x00000000000000000000000000000000000000AA";
  const CHAIN_ID = 97;

  function params(overrides = {}) {
    return {
      chainId: CHAIN_ID,
      agentPay: AGENTPAY,
      challengeId: computeChallengeId(BASE),
      serviceId: BASE.serviceId,
      calls: BASE.calls,
      expiresAt: BASE.expiresAt,
      reqHash: BASE.reqHash,
      ...overrides,
    };
  }

  it("签名能恢复出签名者本人", async function () {
    const wallet = ethers.Wallet.createRandom();
    const sig = await signPayment(wallet, params());
    expect(recoverPaymentSigner(sig, params())).to.equal(wallet.address);
  });

  it("换一把私钥签名，恢复出的是那把私钥的地址（服务端据此识别冒名）", async function () {
    const wallet = ethers.Wallet.createRandom();
    const attacker = ethers.Wallet.createRandom();
    const sig = await signPayment(attacker, params());

    expect(recoverPaymentSigner(sig, params())).to.not.equal(wallet.address);
    expect(recoverPaymentSigner(sig, params())).to.equal(attacker.address);
  });

  it("篡改 reqHash 后恢复不出原地址", async function () {
    const wallet = ethers.Wallet.createRandom();
    const sig = await signPayment(wallet, params());
    const tampered = params({ reqHash: requestHash("GET", "/v1/infer", "被篡改的 prompt") });
    expect(recoverPaymentSigner(sig, tampered)).to.not.equal(wallet.address);
  });

  it("换 chainId 就失效（跨链不可复用）", async function () {
    const wallet = ethers.Wallet.createRandom();
    const sig = await signPayment(wallet, params());
    expect(recoverPaymentSigner(sig, params({ chainId: 56 }))).to.not.equal(wallet.address);
  });

  it("换 AgentPay 合约地址就失效（跨合约不可复用）", async function () {
    const wallet = ethers.Wallet.createRandom();
    const sig = await signPayment(wallet, params());
    const other = "0x00000000000000000000000000000000000000BB";
    expect(recoverPaymentSigner(sig, params({ agentPay: other }))).to.not.equal(wallet.address);
  });
});
