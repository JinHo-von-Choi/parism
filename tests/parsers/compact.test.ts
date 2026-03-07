import { describe, it, expect } from "vitest";
import { toCompact } from "../../src/parsers/compact.js";

describe("toCompact()", () => {
  it("객체 배열을 schema + rows로 변환한다", () => {
    const input = {
      entries: [
        { name: "src", type: "directory", size_bytes: 4096 },
        { name: "main.ts", type: "file", size_bytes: 1200 },
      ],
    };
    const result = toCompact(input);
    expect(result).toEqual({
      entries: {
        schema: ["name", "type", "size_bytes"],
        rows: [["src", "directory", 4096], ["main.ts", "file", 1200]],
      },
    });
  });

  it("빈 배열은 schema=[], rows=[]로 변환한다", () => {
    const input = { entries: [] };
    const result = toCompact(input);
    expect(result).toEqual({ entries: { schema: [], rows: [] } });
  });

  it("배열이 아닌 필드는 그대로 유지한다", () => {
    const input = { path: "/home/user", entries: [{ name: "a" }] };
    const result = toCompact(input);
    expect(result).toEqual({
      path: "/home/user",
      entries: { schema: ["name"], rows: [["a"]] },
    });
  });

  it("중첩 객체가 아닌 배열(문자열 배열 등)은 그대로 유지한다", () => {
    const input = { paths: ["/a", "/b", "/c"] };
    const result = toCompact(input);
    expect(result).toEqual({ paths: ["/a", "/b", "/c"] });
  });

  it("_summary 필드는 그대로 유지한다", () => {
    const input = {
      entries: [{ name: "a", type: "file" }],
      _summary: { total: 100, shown: 1, truncated: true },
    };
    const result = toCompact(input);
    expect(result._summary).toEqual({ total: 100, shown: 1, truncated: true });
    expect(result.entries).toEqual({ schema: ["name", "type"], rows: [["a", "file"]] });
  });

  it("null 입력은 null을 반환한다", () => {
    expect(toCompact(null)).toBeNull();
  });

  it("중첩 배열 필드는 |로 결합된 문자열로 변환한다", () => {
    const input = {
      items: [
        { name: "a", tags: ["x", "y"], args: ["-v", "--help"] },
        { name: "b", tags: ["z"], args: [] },
      ],
    };
    const result = toCompact(input);
    expect(result).toEqual({
      items: {
        schema: ["name", "tags", "args"],
        rows:  [["a", "x|y", "-v|--help"], ["b", "z", ""]],
      },
    });
  });

  it("중첩 객체 필드는 JSON 문자열로 변환한다", () => {
    const input = {
      items: [{ id: 1, meta: { a: 1, b: 2 } }],
    };
    const result = toCompact(input);
    expect(result).toEqual({
      items: {
        schema: ["id", "meta"],
        rows:  [[1, '{"a":1,"b":2}']],
      },
    });
  });
});
