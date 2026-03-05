import { describe, it, expect } from "vitest";
import { paginateLines } from "../../src/engine/paginator.js";

describe("paginateLines()", () => {
  const raw = Array.from({ length: 10 }, (_, i) => `line${i + 1}`).join("\n") + "\n";

  it("page=0, size=3이면 첫 3줄과 page_info를 반환한다", () => {
    const result = paginateLines(raw, 0, 3);
    expect(result.lines).toEqual(["line1", "line2", "line3"]);
    expect(result.page_info).toEqual({
      page: 0, page_size: 3, total_lines: 10, has_next: true,
    });
  });

  it("중간 페이지는 has_next=true이다", () => {
    const result = paginateLines(raw, 1, 3);
    expect(result.lines).toEqual(["line4", "line5", "line6"]);
    expect(result.page_info.has_next).toBe(true);
  });

  it("마지막 페이지는 has_next=false이다", () => {
    const result = paginateLines(raw, 3, 3);  // lines 10~12 → line10만 있음
    expect(result.lines).toEqual(["line10"]);
    expect(result.page_info.has_next).toBe(false);
  });

  it("page가 범위를 벗어나면 빈 lines를 반환한다", () => {
    const result = paginateLines(raw, 99, 3);
    expect(result.lines).toEqual([]);
    expect(result.page_info.has_next).toBe(false);
    expect(result.page_info.total_lines).toBe(10);
  });

  it("빈 raw는 total_lines=0을 반환한다", () => {
    const result = paginateLines("", 0, 10);
    expect(result.page_info.total_lines).toBe(0);
    expect(result.lines).toEqual([]);
    expect(result.page_info.has_next).toBe(false);
  });

  it("trailing newline이 없어도 정상 동작한다", () => {
    const rawNoTrail = "a\nb\nc";
    const result = paginateLines(rawNoTrail, 0, 10);
    expect(result.lines).toEqual(["a", "b", "c"]);
    expect(result.page_info.total_lines).toBe(3);
  });
});
