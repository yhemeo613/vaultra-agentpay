#!/usr/bin/env node
"use strict";

/**
 * 官网静态站点服务器（开发用）。
 * 只做一件事：把 agentpay-site/ 下的文件用正确的 MIME 发出去。
 *
 *   PORT=4023 node agentpay-site/serve.js
 */

const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");

const PORT = Number(process.env.PORT || 4023);
const ROOT = path.join(__dirname);

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};

const server = http.createServer((req, res) => {
  let urlPath = decodeURIComponent(new URL(req.url, "http://localhost").pathname);
  if (urlPath === "/") urlPath = "/index.html";

  const file = path.normalize(path.join(ROOT, urlPath));
  if (!file.startsWith(ROOT)) {
    res.writeHead(403);
    return res.end("forbidden");
  }

  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      return res.end("404 not found");
    }
    res.writeHead(200, {
      "content-type": MIME[path.extname(file).toLowerCase()] || "application/octet-stream",
      "cache-control": "no-store",
    });
    res.end(data);
  });
});

server.listen(PORT, () => {
  console.log(`AgentPay 官网站点: http://127.0.0.1:${PORT}`);
  console.log(`  首页  : http://127.0.0.1:${PORT}/index.html`);
  console.log(`  文档  : http://127.0.0.1:${PORT}/docs.html`);
  console.log(`  演示  : http://127.0.0.1:${PORT}/demo.html`);
  console.log(`  服务商: http://127.0.0.1:${PORT}/provider.html`);
  console.log(`  （服务商数据 API 需另跑 provider-admin/server.js，默认 4022）`);
});
