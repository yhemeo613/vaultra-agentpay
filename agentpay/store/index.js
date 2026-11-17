"use strict";

const { MemoryStore } = require("./memory");
const { SqliteStore } = require("./sqlite");
const { RedisStore } = require("./redis");

/**
 * 统一的 store 工厂。
 *   STORE=memory                 进程内（默认，开发用）
 *   STORE=sqlite STORE_FILE=...  单文件持久化，重启不丢，多进程可共享
 *   STORE=redis  REDIS_URL=...   多实例共享
 */
function createStore(options = {}) {
  const kind = (options.kind || "memory").toLowerCase();

  if (kind === "memory") return new MemoryStore();
  if (kind === "sqlite") return new SqliteStore(options.file || "agentpay.db");
  if (kind === "redis") return new RedisStore(options.url || "redis://127.0.0.1:6379");

  throw new Error(`未知的 STORE 类型: ${kind}（可选 memory / sqlite / redis）`);
}

module.exports = { createStore, MemoryStore, SqliteStore, RedisStore };
