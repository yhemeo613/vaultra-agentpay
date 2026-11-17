"use strict";

/**
 * 推理层测试：mock 回退必须稳定可用；真实 OpenAI 兼容接口走集成路径。
 */

const { expect } = require("chai");
const http = require("node:http");
const { infer, isConfigured, mockInfer } = require("../sdk/inference");

describe("inference", function () {
  it("未配置 baseUrl 时走 mock 且不发起网络请求", async function () {
    const result = await infer("你好", {});
    expect(result.mock).to.equal(true);
    expect(result.text).to.include("[mock:");
    expect(result.model).to.equal("mock-agentpay-v1");
  });

  it("isConfigured 判断正确", function () {
    expect(isConfigured({})).to.equal(false);
    expect(isConfigured({ baseUrl: "https://api.openai.com/v1" })).to.equal(true);
  });

  it("mock 对相同输入稳定", function () {
    expect(mockInfer("abc")).to.equal(mockInfer("abc"));
  });

  it("配置了 baseUrl 时解析 OpenAI 兼容响应", async function () {
    const server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        const parsed = JSON.parse(body);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            model: "fake-model",
            choices: [{ message: { content: `echo:${parsed.messages[0].content}` } }],
            usage: { total_tokens: 5 },
          }),
        );
      });
    });

    await new Promise((r) => server.listen(0, r));
    const port = server.address().port;

    try {
      const result = await infer("ping", { baseUrl: `http://127.0.0.1:${port}/v1` });
      expect(result.mock).to.equal(false);
      expect(result.text).to.equal("echo:ping");
      expect(result.model).to.equal("fake-model");
      expect(result.usage.total_tokens).to.equal(5);
    } finally {
      server.close();
    }
  });

  it("上游非 2xx 时抛错", async function () {
    const server = http.createServer((req, res) => {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "boom" }));
    });

    await new Promise((r) => server.listen(0, r));
    const port = server.address().port;

    try {
      await expect(infer("ping", { baseUrl: `http://127.0.0.1:${port}/v1` })).to.be.rejectedWith(/500/);
    } finally {
      server.close();
    }
  });
});
