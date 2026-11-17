"use strict";

/**
 * 推理层：OpenAI 兼容接口 + mock 回退。
 *
 * 配了 LLM_BASE_URL 就走真实模型，没配就走 mock。
 * 计费逻辑完全不感知这里 —— 换供应商只改环境变量。
 */

const crypto = require("node:crypto");

const DEFAULT_TIMEOUT_MS = 25_000;

function isConfigured(config) {
  return Boolean(config && config.baseUrl);
}

function mockInfer(prompt) {
  const digest = crypto.createHash("sha256").update(String(prompt)).digest("hex").slice(0, 8);
  return `[mock:${digest}] 已收到 ${String(prompt).length} 字符输入。设置 LLM_BASE_URL 后这里会走真实模型。`;
}

/**
 * @param {string} prompt
 * @param {{baseUrl?:string, apiKey?:string, model?:string, temperature?:number, maxTokens?:number, timeoutMs?:number}} config
 */
async function infer(prompt, config = {}) {
  if (!isConfigured(config)) {
    return { text: mockInfer(prompt), model: "mock-agentpay-v1", mock: true, usage: null };
  }

  const url = `${String(config.baseUrl).replace(/\/+$/, "")}/chat/completions`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs || DEFAULT_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(config.apiKey ? { authorization: `Bearer ${config.apiKey}` } : {}),
      },
      body: JSON.stringify({
        model: config.model || "gpt-4o-mini",
        messages: [{ role: "user", content: String(prompt) }],
        temperature: config.temperature ?? 0.7,
        max_tokens: config.maxTokens ?? 512,
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new Error(`推理服务返回 ${response.status}: ${detail.slice(0, 200)}`);
    }

    const data = await response.json();
    const text = data?.choices?.[0]?.message?.content;
    if (typeof text !== "string") {
      throw new Error("推理服务返回里没有 choices[0].message.content");
    }

    return { text, model: data.model || config.model || "unknown", mock: false, usage: data.usage ?? null };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { infer, mockInfer, isConfigured };
