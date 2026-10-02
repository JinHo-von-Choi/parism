import { describe, it, expect } from "vitest";
import { PageCache } from "../../src/engine/page-cache.js";

const env = { ok: true } as never;
describe("PageCache", () => {
  it("TTL 안에서는 같은 항목을 돌려준다", () => {
    const c = new PageCache(1000, 4);
    c.set("k", { envelope: env, createdAt: 0 }, 0);
    expect(c.get("k", 999)?.envelope).toBe(env);
  });
  it("TTL이 지나면 undefined", () => {
    const c = new PageCache(1000, 4);
    c.set("k", { envelope: env, createdAt: 0 }, 0);
    expect(c.get("k", 1001)).toBeUndefined();
  });
  it("maxEntries를 넘으면 가장 오래 안 쓴 항목을 제거한다", () => {
    const c = new PageCache(1000, 2);
    c.set("a", { envelope: env, createdAt: 0 }, 0);
    c.set("b", { envelope: env, createdAt: 0 }, 0);
    c.get("a", 1);
    c.set("c", { envelope: env, createdAt: 0 }, 2);
    expect(c.get("b", 3)).toBeUndefined();
    expect(c.get("a", 3)).toBeDefined();
  });
});
