"use strict";

/**
 * EIP-712 付款确认签名
 *
 * 为什么需要它：仅凭链上有这笔 tx，服务端无法区分「付款人本人来取结果」
 * 和「别人截获 txHash 后来蹭结果」。EIP-712 让付款人对自己要消费的
 * challenge 签一次名，服务端用链上 Paid 事件的 payer 地址去验签，
 * 两边对上才放行 —— 付款人和调用人从此是同一个地址。
 *
 * 签名覆盖：challengeId / serviceId / calls / expiresAt / reqHash
 * 域分隔：name+version+chainId+verifyingContract，跨链、跨合约都无法复用。
 */

const { ethers } = require("ethers");

const DOMAIN_NAME = "AgentPay";
const DOMAIN_VERSION = "1";

const PAYMENT_TYPES = {
  Payment: [
    { name: "challengeId", type: "bytes32" },
    { name: "serviceId", type: "bytes32" },
    { name: "calls", type: "uint256" },
    { name: "expiresAt", type: "uint256" },
    { name: "reqHash", type: "bytes32" },
  ],
};

function typedDataDomain({ chainId, agentPay }) {
  return {
    name: DOMAIN_NAME,
    version: DOMAIN_VERSION,
    chainId: Number(chainId),
    verifyingContract: agentPay,
  };
}

function paymentValue({ challengeId, serviceId, calls, expiresAt, reqHash }) {
  return {
    challengeId,
    serviceId,
    calls: BigInt(calls),
    expiresAt: BigInt(expiresAt),
    reqHash,
  };
}

/** 付款人签名（Wallet / 任意 Signer 都行） */
async function signPayment(signer, params) {
  const { chainId, agentPay, ...rest } = params;
  return signer.signTypedData(
    typedDataDomain({ chainId, agentPay }),
    PAYMENT_TYPES,
    paymentValue(rest),
  );
}

/** 服务端验签，返回签名者地址；签名格式非法时抛错 */
function recoverPaymentSigner(signature, params) {
  const { chainId, agentPay, ...rest } = params;
  return ethers.verifyTypedData(
    typedDataDomain({ chainId, agentPay }),
    PAYMENT_TYPES,
    paymentValue(rest),
    signature,
  );
}

module.exports = {
  DOMAIN_NAME,
  DOMAIN_VERSION,
  PAYMENT_TYPES,
  typedDataDomain,
  paymentValue,
  signPayment,
  recoverPaymentSigner,
};
