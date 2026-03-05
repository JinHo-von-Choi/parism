import { describe, it, expect } from "vitest";
import { computeDiff } from "../../src/engine/state-tracker.js";

describe("computeDiff()", () => {
  it("변경 없으면 빈 diff를 반환한다", () => {
    const snap = new Map([["a.txt", 1000], ["b.txt", 2000]]);
    const diff = computeDiff(snap, snap);

    expect(diff.created).toHaveLength(0);
    expect(diff.deleted).toHaveLength(0);
    expect(diff.modified).toHaveLength(0);
  });

  it("새 파일은 created에 포함된다", () => {
    const before = new Map([["a.txt", 1000]]);
    const after  = new Map([["a.txt", 1000], ["b.txt", 2000]]);
    const diff   = computeDiff(before, after);

    expect(diff.created).toContain("b.txt");
    expect(diff.deleted).toHaveLength(0);
    expect(diff.modified).toHaveLength(0);
  });

  it("삭제된 파일은 deleted에 포함된다", () => {
    const before = new Map([["a.txt", 1000], ["b.txt", 2000]]);
    const after  = new Map([["a.txt", 1000]]);
    const diff   = computeDiff(before, after);

    expect(diff.deleted).toContain("b.txt");
    expect(diff.created).toHaveLength(0);
    expect(diff.modified).toHaveLength(0);
  });

  it("mtime 변경된 파일은 modified에 포함된다", () => {
    const before = new Map([["a.txt", 1000]]);
    const after  = new Map([["a.txt", 9999]]);
    const diff   = computeDiff(before, after);

    expect(diff.modified).toContain("a.txt");
    expect(diff.created).toHaveLength(0);
    expect(diff.deleted).toHaveLength(0);
  });
});
