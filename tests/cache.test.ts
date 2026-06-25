import { afterEach, describe, expect, it, vi } from "vitest";
import { cacheKey, type CacheStore } from "../src/index.js";
import { createCacheStore } from "../src/cache.js";

describe("cacheKey()", () => {
  it("collides on same namespace + model + hash, differs otherwise", () => {
    expect(cacheKey("acc:cache", "gpt-4o", "abc")).toBe("acc:cache:gpt-4o:abc");
    expect(cacheKey("acc:cache", "gpt-4o", "abc")).not.toBe(cacheKey("acc:cache", "gpt-4o-mini", "abc"));
  });
});

describe("memory cache store", () => {
  it("stores and returns a value, misses on unknown key", async () => {
    const store = createCacheStore({ provider: "memory" }) as CacheStore;
    expect(await store.get("k")).toBeUndefined();
    await store.set("k", { hello: "world" }, 60);
    expect(await store.get("k")).toEqual({ hello: "world" });
  });

  it("expires entries past their TTL", async () => {
    vi.useFakeTimers();
    try {
      const store = createCacheStore({ provider: "memory" }) as CacheStore;
      await store.set("k", 1, 60);
      expect(await store.get("k")).toBe(1);
      vi.advanceTimersByTime(61_000);
      expect(await store.get("k")).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });
});

afterEach(() => vi.useRealTimers());

describe("createCacheStore()", () => {
  it("returns null when disabled", () => {
    expect(createCacheStore({ enabled: false })).toBeNull();
  });
  it("returns null for misconfigured BYODB (no url/token)", () => {
    expect(createCacheStore({ provider: "upstash" })).toBeNull();
    expect(createCacheStore({ provider: "redis" })).toBeNull();
  });
  it("defaults to a memory store", () => {
    expect(createCacheStore({})).not.toBeNull();
  });
  it("builds a managed store only with accKey + cacheUrl context", () => {
    expect(createCacheStore({ provider: "managed" })).toBeNull();
    expect(
      createCacheStore({ provider: "managed" }, { accKey: "acc_x", cacheUrl: "https://x/v1/cache" }),
    ).not.toBeNull();
  });
});

describe("cacheUrlFrom()", () => {
  it("derives the /v1/cache URL from the events endpoint", async () => {
    const { cacheUrlFrom } = await import("../src/cache.js");
    expect(cacheUrlFrom("https://x.test/v1/events")).toBe("https://x.test/v1/cache");
    expect(cacheUrlFrom("https://x.test/v1/")).toBe("https://x.test/v1/cache");
  });
});
