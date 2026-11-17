"use strict";

/**
 * 极小的 HTTP 客户端，替代 fetch。
 * 原因：要让 SDK 能带客户端证书做 mTLS，fetch 在 Node 里拿不到 TLS 选项。
 */

const http = require("node:http");
const https = require("node:https");

/**
 * @param {string} url
 * @param {{method?:string, headers?:Record<string,string>, body?:string, timeoutMs?:number,
 *          tls?:{ca?:any, cert?:any, key?:any, rejectUnauthorized?:boolean, servername?:string}}} options
 * @returns {Promise<{status:number, headers:object, body:any}>}
 */
function requestJson(url, options = {}) {
  const { method = "GET", headers = {}, body, timeoutMs = 20_000, tls = {} } = options;
  const target = new URL(url);
  const isHttps = target.protocol === "https:";

  const requestOptions = { method, headers };

  if (isHttps) {
    if (tls.ca !== undefined) requestOptions.ca = tls.ca;
    if (tls.cert !== undefined) requestOptions.cert = tls.cert;
    if (tls.key !== undefined) requestOptions.key = tls.key;
    if (tls.servername !== undefined) requestOptions.servername = tls.servername;
    requestOptions.rejectUnauthorized = tls.rejectUnauthorized ?? true;
  }

  return new Promise((resolve, reject) => {
    const transport = isHttps ? https : http;
    const req = transport.request(target, requestOptions, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        const raw = Buffer.concat(chunks).toString("utf8");
        let parsed;
        try {
          parsed = raw ? JSON.parse(raw) : null;
        } catch {
          parsed = { raw };
        }
        resolve({ status: res.statusCode, headers: res.headers, body: parsed });
      });
    });

    req.setTimeout(timeoutMs, () => req.destroy(new Error(`请求超时 (${timeoutMs}ms)`)));
    req.on("error", reject);

    if (body !== undefined) req.write(body);
    req.end();
  });
}

module.exports = { requestJson };
