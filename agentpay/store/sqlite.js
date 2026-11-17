"use strict";

/**
 * 基于 Node 内置 node:sqlite 的持久化 KV。
 * 不需要额外服务，单文件落盘，重启不丢；多个进程指向同一个文件时用 WAL 共享读。
 */

const { DatabaseSync } = require("node:sqlite");

class SqliteStore {
  constructor(file) {
    this.file = file;
    this.db = new DatabaseSync(file);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA busy_timeout = 5000");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS kv (
        key        TEXT PRIMARY KEY,
        value      TEXT NOT NULL,
        expires_at INTEGER NOT NULL
      )
    `);
  }

  async get(key) {
    const row = this.db.prepare("SELECT value, expires_at FROM kv WHERE key = ?").get(key);
    if (!row) return null;
    if (Number(row.expires_at) <= Date.now()) {
      this.db.prepare("DELETE FROM kv WHERE key = ?").run(key);
      return null;
    }
    return row.value;
  }

  async set(key, value, ttlMs) {
    const expiresAt = ttlMs ? Date.now() + ttlMs : Number.MAX_SAFE_INTEGER;
    this.db
      .prepare(
        `INSERT INTO kv (key, value, expires_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, expires_at = excluded.expires_at`,
      )
      .run(key, value, expiresAt);
  }

  /** 仅当 key 不存在时写入（数据库层面原子）；返回是否获得锁 */
  async setNx(key, value, ttlMs) {
    const expiresAt = ttlMs ? Date.now() + ttlMs : Number.MAX_SAFE_INTEGER;
    const existing = this.db.prepare("SELECT 1 FROM kv WHERE key = ? AND expires_at > ?").get(key, Date.now());
    if (existing) return false;
    try {
      this.db.prepare("INSERT INTO kv (key, value, expires_at) VALUES (?, ?, ?)").run(key, value, expiresAt);
      return true;
    } catch {
      return false; // 主键冲突 = 锁已被占用
    }
  }

  async del(key) {
    this.db.prepare("DELETE FROM kv WHERE key = ?").run(key);
  }

  async sweep() {
    this.db.prepare("DELETE FROM kv WHERE expires_at <= ?").run(Date.now());
  }

  async close() {
    this.db.close();
  }
}

module.exports = { SqliteStore };
