"use strict";

/**
 * 极小的 KV 接口，服务端只依赖这四个方法。
 * 目的：challenge 不再绑死在进程内存里 —— 换 sqlite / redis 即可跨重启、跨实例。
 */

class MemoryStore {
  constructor() {
    this.map = new Map();
  }

  async get(key) {
    const entry = this.map.get(key);
    if (!entry) return null;
    if (entry.expiresAt && entry.expiresAt <= Date.now()) {
      this.map.delete(key);
      return null;
    }
    return entry.value;
  }

  async set(key, value, ttlMs) {
    this.map.set(key, { value, expiresAt: ttlMs ? Date.now() + ttlMs : 0 });
  }

  /** 仅当 key 不存在时写入；返回是否获得锁 */
  async setNx(key, value, ttlMs) {
    const entry = this.map.get(key);
    if (entry && (!entry.expiresAt || entry.expiresAt > Date.now())) return false;
    this.map.set(key, { value, expiresAt: ttlMs ? Date.now() + ttlMs : 0 });
    return true;
  }

  async del(key) {
    this.map.delete(key);
  }

  async sweep() {
    const now = Date.now();
    for (const [key, entry] of this.map) {
      if (entry.expiresAt && entry.expiresAt <= now) this.map.delete(key);
    }
  }

  async close() {}
}

module.exports = { MemoryStore };
