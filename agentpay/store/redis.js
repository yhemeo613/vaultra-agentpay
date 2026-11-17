"use strict";

/**
 * Redis 适配器，自带一个够用的 RESP2 客户端（不引第三方依赖）。
 * 只用得到 SET / GET / DEL / PING，多实例共享同一份 challenge 状态就靠它。
 */

const net = require("node:net");

class RedisError extends Error {}

/** 解析一条 RESP 回复；数据不够时返回 null，等下一个 chunk */
function parseReply(buf, offset = 0) {
  if (offset >= buf.length) return null;

  const type = buf[offset];
  const lineEnd = buf.indexOf("\r\n", offset);
  if (lineEnd === -1) return null;

  const line = buf.toString("utf8", offset + 1, lineEnd);
  const next = lineEnd + 2;

  switch (type) {
    case 43: // +
      return { value: line, offset: next };
    case 45: // -
      return { value: new RedisError(line), offset: next };
    case 58: // :
      return { value: Number(line), offset: next };
    case 36: {
      // $
      const len = Number(line);
      if (len === -1) return { value: null, offset: next };
      if (buf.length < next + len + 2) return null;
      return { value: buf.toString("utf8", next, next + len), offset: next + len + 2 };
    }
    case 42: {
      // *
      const count = Number(line);
      if (count === -1) return { value: null, offset: next };
      let off = next;
      const items = [];
      for (let i = 0; i < count; i++) {
        const item = parseReply(buf, off);
        if (!item) return null;
        items.push(item.value);
        off = item.offset;
      }
      return { value: items, offset: off };
    }
    default:
      throw new Error(`无法识别的 RESP 类型: ${type}`);
  }
}

function encodeCommand(args) {
  const parts = [`*${args.length}\r\n`];
  for (const arg of args) {
    const str = String(arg);
    parts.push(`$${Buffer.byteLength(str)}\r\n${str}\r\n`);
  }
  return Buffer.from(parts.join(""), "utf8");
}

class RedisClient {
  constructor(url) {
    const parsed = new URL(url || "redis://127.0.0.1:6379");
    this.host = parsed.hostname || "127.0.0.1";
    this.port = Number(parsed.port || 6379);
    this.password = parsed.password ? decodeURIComponent(parsed.password) : null;
    this.db = parsed.pathname && parsed.pathname !== "/" ? Number(parsed.pathname.slice(1)) : 0;

    this.socket = null;
    this.buffer = Buffer.alloc(0);
    this.pending = [];
    this.readyPromise = null;
  }

  connect() {
    if (this.socket && !this.socket.destroyed) return Promise.resolve();
    this.socket = net.connect(this.port, this.host);
    this.socket.on("data", (chunk) => {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      this.drain();
    });
    this.socket.on("error", (err) => this.rejectAll(err));
    this.socket.on("close", () => {
      this.rejectAll(new Error("redis 连接已关闭"));
      this.socket = null;
      this.readyPromise = null;
    });
    return new Promise((resolve, reject) => {
      this.socket.once("connect", resolve);
      this.socket.once("error", reject);
    });
  }

  drain() {
    while (this.pending.length > 0) {
      const parsed = parseReply(this.buffer, 0);
      if (!parsed) return;
      this.buffer = this.buffer.subarray(parsed.offset);
      const waiter = this.pending.shift();
      if (parsed.value instanceof RedisError) waiter.reject(parsed.value);
      else waiter.resolve(parsed.value);
    }
  }

  rejectAll(err) {
    for (const waiter of this.pending.splice(0)) waiter.reject(err);
  }

  /** 写一条命令，不检查连接状态 */
  write(args) {
    return new Promise((resolve, reject) => {
      this.pending.push({ resolve, reject });
      this.socket.write(encodeCommand(args));
    });
  }

  async ready() {
    if (this.readyPromise) return this.readyPromise;
    this.readyPromise = (async () => {
      await this.connect();
      if (this.password) await this.write(["AUTH", this.password]);
      if (this.db) await this.write(["SELECT", String(this.db)]);
    })();
    return this.readyPromise;
  }

  async command(args) {
    await this.ready();
    return this.write(args);
  }

  close() {
    if (this.socket) this.socket.end();
    this.socket = null;
    this.readyPromise = null;
  }
}

class RedisStore {
  constructor(url) {
    this.client = new RedisClient(url);
  }

  async get(key) {
    const value = await this.client.command(["GET", key]);
    return value === null || value === undefined ? null : value;
  }

  async set(key, value, ttlMs) {
    if (ttlMs) {
      await this.client.command(["SET", key, value, "PX", String(Math.max(1, Math.round(ttlMs)))]);
    } else {
      await this.client.command(["SET", key, value]);
    }
  }

  /** SET NX：仅当 key 不存在时写入；返回是否获得锁 */
  async setNx(key, value, ttlMs) {
    const result = await this.client.command(["SET", key, value, "NX", "PX", String(Math.max(1, Math.round(ttlMs)))]);
    return result === "OK";
  }

  async del(key) {
    await this.client.command(["DEL", key]);
  }

  async sweep() {}

  async ping() {
    return this.client.command(["PING"]);
  }

  async close() {
    this.client.close();
  }
}

module.exports = { RedisStore, RedisClient, RedisError, parseReply };
