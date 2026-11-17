"use strict";

/**
 * challenge 的唯一真源：服务端和客户端都必须用这里的函数，
 * 否则两边算出的 challengeId 会不一致，付款就对不上。
 */

const { ethers } = require("ethers");

/** challenge 有效期（秒） */
const CHALLENGE_TTL_SECONDS = 120;

/**
 * 把一次具体请求压成 32 字节。
 * 换一个 prompt 就是另一笔账 —— 这是「一次付款绑定一次请求」的核心。
 */
function requestHash(method, path, payload) {
  return ethers.keccak256(ethers.toUtf8Bytes(`${method.toUpperCase()}|${path}|${payload ?? ""}`));
}

/** challengeId = keccak256(nonce, serviceId, calls, expiresAt, requestHash) */
function computeChallengeId({ nonce, serviceId, calls, expiresAt, reqHash }) {
  return ethers.keccak256(
    ethers.solidityPacked(
      ["bytes32", "bytes32", "uint256", "uint256", "bytes32"],
      [nonce, serviceId, BigInt(calls), BigInt(expiresAt), reqHash],
    ),
  );
}

/** 32 字节随机 nonce，保证每次签发的 challenge 唯一 */
function newNonce() {
  return ethers.hexlify(ethers.randomBytes(32));
}

module.exports = { CHALLENGE_TTL_SECONDS, requestHash, computeChallengeId, newNonce };
