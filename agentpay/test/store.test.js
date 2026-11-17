"use strict";

/**
 * store 层测试：memory + sqlite 必测；redis 在 REDIS_TEST_URL 存在时测。
 * 三个实现都必须满足同一个契约：set/get/del + TTL 过期。
 */

const { expect } = require("chai");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { MemoryStore } = require("../store/memory");
const { SqliteStore } = require("../store/sqlite");
const { RedisStore } = require("../store/redis");

const REDIS_TEST_URL = process.env.REDIS_TEST_URL || "";

function tmpFile() {
  return path.join(os.tmpdir(), `agentpay-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
}

function testStoreSuite(name, makeStore, close) {
  describe(`${name} store`, function () {
    let store;

    beforeEach(async function () {
      store = await makeStore();
    });

    afterEach(async function () {
      await close(store);
    });

    it("set / get / del 往返", async function () {
      await store.set("a", "hello", 10_000);
      expect(await store.get("a")).to.equal("hello");

      await store.set("b", JSON.stringify({ used: true }), 10_000);
      expect(JSON.parse(await store.get("b")).used).to.equal(true);

      await store.del("a");
      expect(await store.get("a")).to.be.null;
    });

    it("TTL 过期后读不到", async function () {
      await store.set("exp", "gone", 50);
      expect(await store.get("exp")).to.equal("gone");

      await new Promise((r) => setTimeout(r, 120));
      expect(await store.get("exp")).to.be.null;
    });

    it("无 TTL 的 key 不消失", async function () {
      await store.set("keep", "forever");
      await new Promise((r) => setTimeout(r, 80));
      expect(await store.get("keep")).to.equal("forever");
    });

    it("重写会覆盖旧值", async function () {
      await store.set("k", "v1", 60_000);
      await store.set("k", "v2", 60_000);
      expect(await store.get("k")).to.equal("v2");
    });

    it("setNx：第一次获得锁，第二次拿不到，过期后可再拿", async function () {
      expect(await store.setNx("lock", "1", 200)).to.equal(true);
      expect(await store.setNx("lock", "1", 200)).to.equal(false);
      expect(await store.get("lock")).to.equal("1");

      await store.del("lock");
      expect(await store.setNx("lock", "1", 200)).to.equal(true);
    });
  });
}

describe("store 契约", function () {
  testStoreSuite(
    "memory",
    async () => new MemoryStore(),
    async (s) => s.close(),
  );

  testStoreSuite(
    "sqlite",
    async () => {
      const file = tmpFile();
      const s = new SqliteStore(file);
      s._file = file;
      return s;
    },
    async (s) => {
      await s.close();
      if (s._file) fs.rmSync(s._file, { force: true });
      try {
        fs.rmSync(`${s._file}-wal`, { force: true });
        fs.rmSync(`${s._file}-shm`, { force: true });
      } catch {
        /* ignore */
      }
    },
  );

  if (REDIS_TEST_URL) {
    testStoreSuite(
      "redis",
      async () => new RedisStore(REDIS_TEST_URL),
      async (s) => s.close(),
    );
  }
});
