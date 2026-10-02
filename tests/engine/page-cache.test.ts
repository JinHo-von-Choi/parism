import { describe, it, expect } from "vitest";
import { PageCache } from "../../src/engine/page-cache.js";

/** stdout 원문 길이를 지정한 최소 봉투 */
const envOf = (stdout = "", stderr = "") => ({ ok: true, stdout: { raw: stdout }, stderr: { raw: stderr } }) as never;
const env   = envOf();

describe("PageCache", () => {
  it("TTL 안에서는 같은 항목을 돌려준다", () => {
    const c = new PageCache(1000, 4, 1024);
    c.set("k", { envelope: env, createdAt: 0 }, 0);
    expect(c.get("k", 999)?.envelope).toBe(env);
  });
  it("TTL이 지나면 undefined", () => {
    const c = new PageCache(1000, 4, 1024);
    c.set("k", { envelope: env, createdAt: 0 }, 0);
    expect(c.get("k", 1001)).toBeUndefined();
  });
  it("maxEntries를 넘으면 가장 오래 안 쓴 항목을 제거한다", () => {
    const c = new PageCache(1000, 2, 1024);
    c.set("a", { envelope: env, createdAt: 0 }, 0);
    c.set("b", { envelope: env, createdAt: 0 }, 0);
    c.get("a", 1);
    c.set("c", { envelope: env, createdAt: 0 }, 2);
    expect(c.get("b", 3)).toBeUndefined();
    expect(c.get("a", 3)).toBeDefined();
  });
  it("바이트 합계가 maxBytes를 넘으면 가장 오래 안 쓴 항목부터 제거한다", () => {
    const c = new PageCache(1000, 16, 10);
    c.set("a", { envelope: envOf("aaaa"), createdAt: 0 }, 0);
    c.set("b", { envelope: envOf("bb", "bb"), createdAt: 0 }, 0);
    c.set("c", { envelope: envOf("cccc"), createdAt: 0 }, 0);
    expect(c.get("a", 1)).toBeUndefined();
    expect(c.get("b", 1)).toBeDefined();
    expect(c.get("c", 1)).toBeDefined();
    expect(c.bytes).toBe(8);
  });
  it("maxBytes보다 큰 항목은 저장하지 않고 기존 항목도 유지한다", () => {
    const c = new PageCache(1000, 16, 10);
    c.set("a", { envelope: envOf("aaaa"), createdAt: 0 }, 0);
    c.set("big", { envelope: envOf("x".repeat(11)), createdAt: 0 }, 0);
    expect(c.get("big", 1)).toBeUndefined();
    expect(c.get("a", 1)).toBeDefined();
    expect(c.bytes).toBe(4);
  });
  it("같은 키를 다시 저장하면 이전 크기를 합계에서 뺀다", () => {
    const c = new PageCache(1000, 16, 100);
    c.set("a", { envelope: envOf("aaaa"), createdAt: 0 }, 0);
    c.set("a", { envelope: envOf("aa"), createdAt: 0 }, 0);
    expect(c.bytes).toBe(2);
  });
});
