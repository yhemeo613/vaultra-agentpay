#!/usr/bin/env node
"use strict";

/**
 * 生成自签名的服务端证书和客户端证书，用于本地跑 HTTPS / mTLS。
 * 生产环境请换成真实 CA 签发的证书。
 */

const fs = require("node:fs");
const path = require("node:path");
const selfsigned = require("selfsigned");

async function makeCert(commonName, altNames) {
  return selfsigned.generate([{ name: "commonName", value: commonName }], {
    days: 365,
    keySize: 2048,
    algorithm: "sha256",
    extensions: [
      { name: "basicConstraints", cA: false },
      {
        name: "subjectAltName",
        altNames: altNames.map((value) => ({ type: 2, value })),
      },
    ],
  });
}

async function main() {
  const dir = path.join(__dirname, "..", "certs");
  fs.mkdirSync(dir, { recursive: true });

  const server = await makeCert("localhost", ["localhost", "127.0.0.1"]);
  const client = await makeCert("agentpay-client", ["agentpay-client"]);

  fs.writeFileSync(path.join(dir, "server.crt"), server.cert);
  fs.writeFileSync(path.join(dir, "server.key"), server.private);
  fs.writeFileSync(path.join(dir, "client.crt"), client.cert);
  fs.writeFileSync(path.join(dir, "client.key"), client.private);

  console.log("已生成:");
  console.log(`  ${path.join(dir, "server.crt")}  (server)`);
  console.log(`  ${path.join(dir, "server.key")}  (server)`);
  console.log(`  ${path.join(dir, "client.crt")}  (mTLS 客户端)`);
  console.log(`  ${path.join(dir, "client.key")}  (mTLS 客户端)`);
  console.log(`\nserver fingerprint: ${server.fingerprint}`);
  console.log(`client fingerprint: ${client.fingerprint}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
