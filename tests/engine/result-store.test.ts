/**
 * 마스킹이 근거 구간을 어긋나게 하지 않는지, 저장소가 약속을 지키는지 확인한다.
 *
 * 작성자: 최진호
 * 작성일: 2026-10-05
 */

import { describe, it, expect } from "vitest";
import { maskWithRanges, mapOffset, mapRange } from "../../src/engine/mask-map.js";
import { ResultStore, resolvePointer, type StoredResult } from "../../src/engine/result-store.js";
import { DEFAULT_RESULT_STORE_LIMITS } from "../../src/engine/result-store.js";
import { hashContent } from "../../src/engine/evidence.js";

const PATTERNS = ["sk-[A-Za-z0-9]{8,}", "AKIA[0-9A-Z]{4}"];

describe("마스킹과 오프셋 대응", () => {
  it("마스킹이 없으면 위치가 그대로다", () => {
    const text = "keepA keepB tail";
    const m = maskWithRanges(text, PATTERNS);
    expect(m.count).toBe(0);
    expect(mapOffset(m.ranges, 6)).toBe(6);
    expect(mapRange(m.ranges, 6, 11)).toEqual({ start: 6, end: 11 });
  });

  it("앞부분이 가려져도 뒤 위치가 정확히 옮겨진다", () => {
    const before = "sk-abcdefgh tail keepA";
    const m = maskWithRanges(before, PATTERNS);
    expect(m.text).toBe("[REDACTED] tail keepA");
    expect(mapOffset(m.ranges, before.indexOf("keepA"))).toBe(m.text.indexOf("keepA"));
    expect(mapOffset(m.ranges, before.indexOf("tail"))).toBe(m.text.indexOf("tail"));
  });

  it("여러 구간이 가려져도 각 위치를 원문에서 찾는다", () => {
    const before = "keepA sk-abcdefgh keepB sk-12345678 tail";
    const m = maskWithRanges(before, PATTERNS);
    for (const needle of ["keepA", "keepB", "tail"]) {
      expect(mapOffset(m.ranges, before.indexOf(needle)), needle).toBe(m.text.indexOf(needle));
    }
  });

  it("여러 패턴이 순서대로 적용되어도 원문 좌표로 돌아온다", () => {
    const before = "keepA AKIA1234 keepB sk-zzzzzzzz tail";
    const m = maskWithRanges(before, PATTERNS);
    expect(m.count).toBe(2);
    for (const needle of ["keepA", "keepB", "tail"]) {
      expect(mapOffset(m.ranges, before.indexOf(needle)), needle).toBe(m.text.indexOf(needle));
    }
  });

  it("가려진 구간 안의 위치는 치환 토큰을 가리킨다", () => {
    const before = "sk-abcdefgh tail";
    const m = maskWithRanges(before, PATTERNS);
    expect(mapOffset(m.ranges, 3)).toBe(0);
  });

  it("가려진 구간에 걸친 범위는 치환 토큰 길이에 맞춰 좁아진다", () => {
    const before = "sk-abcdefgh tail";
    const m = maskWithRanges(before, PATTERNS);
    const r = mapRange(m.ranges, 3, 6);
    expect(r).toEqual({ start: 0, end: "[REDACTED]".length });
  });

  it("해시는 내용에만 의존한다", () => {
    expect(hashContent("abc")).toBe(hashContent("abc"));
    expect(hashContent("abc")).not.toBe(hashContent("abd"));
  });
});

function stored(id: string, bytes: number, ageMs = 0): StoredResult {
  return {
    resultId: id, createdAt: Date.now() - ageMs,
    stdout: "out", stderr: "", parsed: { a: 1 }, evidence: {},
    review: {} as never, bytes, cmd: "echo", args: [], cwd: "/",
  };
}

describe("결과 저장소", () => {
  it("한도 안이면 보관하고 되돌려준다", () => {
    const store = new ResultStore();
    expect(store.put(stored("r1", 100)).retained).toBe(true);
    const got = store.get("r1");
    expect(got.found).toBe(true);
    expect(store.size).toBe(1);
    expect(store.bytes).toBe(100);
  });

  it("결과 하나의 한도를 넘으면 보관하지 않고 그 사실을 알린다", () => {
    const store = new ResultStore({ ...DEFAULT_RESULT_STORE_LIMITS, maxBytesPerResult: 1000 });
    const put = store.put(stored("r1", 2000));
    expect(put.retained).toBe(false);
    expect(put.reason).toMatch(/over the 1000 byte/);
    expect(store.size).toBe(0);
    const got = store.get("r1");
    expect(got.found).toBe(false);
    expect(got.found === false && got.reason).toBe("evicted");
  });

  it("개수 한도를 넘으면 가장 오래 쓰이지 않은 것을 비운다", () => {
    const store = new ResultStore({ ...DEFAULT_RESULT_STORE_LIMITS, maxEntries: 2 });
    store.put(stored("r1", 10));
    store.put(stored("r2", 10));
    store.get("r1");
    store.put(stored("r3", 10));
    expect(store.get("r2").found).toBe(false);
    expect(store.get("r1").found).toBe(true);
    expect(store.get("r3").found).toBe(true);
  });

  it("보관하지 않은 결과를 조회하면 자동 재실행하지 않는다", () => {
    const store = new ResultStore();
    const got = store.get("r_없음");
    expect(got.found).toBe(false);
    expect(got.found === false && got.reason).toBe("unknown_id");
    expect(got.found === false && got.message).toMatch(/not re-executed/);
  });

  it("처음부터 보관하지 않은 id 는 모르는 id 와 구분해 알려준다", () => {
    const store = new ResultStore();
    store.markNotRetained("r_안보관");
    const marked = store.get("r_안보관");
    expect(marked.found).toBe(false);
    expect(marked.found === false && marked.reason).toBe("not_retained");
    expect(marked.found === false && marked.message).toMatch(/not_retained/);

    /** 둘의 원인이 다르므로 사유도 달라야 다음 행동이 정해진다 */
    const unknown = store.get("r_모르는id");
    expect(unknown.found === false && unknown.reason).toBe("unknown_id");
  });

  it("보관하지 않았다고 기록해도 재실행하지 않는다", () => {
    const store = new ResultStore();
    store.markNotRetained("r_안보관");
    expect(store.get("r_안보관").found).toBe(false);
    expect(store.size).toBe(0);
  });

  it("보관 기간이 지나면 만료된다", () => {
    const store = new ResultStore({ ...DEFAULT_RESULT_STORE_LIMITS, ttlMs: 10 });
    store.put(stored("r1", 10, 1000));
    const got = store.get("r1");
    expect(got.found).toBe(false);
    expect(got.found === false && got.reason).toBe("expired");
  });

  it("전체 바이트 한도를 넘으면 비우고 새 결과를 넣는다", () => {
    const store = new ResultStore({ ...DEFAULT_RESULT_STORE_LIMITS, maxBytesTotal: 1000, maxEntries: 100 });
    store.put(stored("r1", 600));
    store.put(stored("r2", 600));
    expect(store.get("r1").found).toBe(false);
    expect(store.get("r2").found).toBe(true);
    expect(store.bytes).toBeLessThanOrEqual(1000);
  });
});

describe("JSON Pointer 해석", () => {
  const doc = { processes: [{ pid: 1, user: "root" }], _summary: { total: 1 } };

  it("객체와 배열 경로를 따라간다", () => {
    expect(resolvePointer(doc, "/processes/0/pid")).toBe(1);
    expect(resolvePointer(doc, "/_summary/total")).toBe(1);
  });

  it("빈 포인터는 전체를 가리킨다", () => {
    expect(resolvePointer(doc, "")).toBe(doc);
  });

  it("없는 경로와 잘못된 배열 인덱스는 undefined 다", () => {
    expect(resolvePointer(doc, "/nope")).toBeUndefined();
    expect(resolvePointer(doc, "/processes/x/pid")).toBeUndefined();
  });

  it("~0 과 ~1 이스케이프를 해석한다", () => {
    expect(resolvePointer({ "a/b": 1, "c~d": 2 }, "/a~1b")).toBe(1);
    expect(resolvePointer({ "a/b": 1, "c~d": 2 }, "/c~0d")).toBe(2);
  });
});
