import { describe, it, expect } from "vitest";
import { parseWc }   from "../../src/parsers/text/wc.js";
import { parseGrep } from "../../src/parsers/text/grep.js";

describe("parseWc()", () => {
  it("wc 출력을 파싱한다", () => {
    const result = parseWc("wc", ["-l"], "  42 src/index.ts\n") as { entries: Array<{ count: number; file: string }> };
    expect(result.entries[0]).toEqual({ count: 42, file: "src/index.ts" });
  });
});

describe("parseGrep()", () => {
  it("grep 결과를 라인 목록으로 파싱한다", () => {
    const raw    = "src/index.ts:10:import { foo }\nsrc/server.ts:5:import { foo }\n";
    const result = parseGrep("grep", ["-rn", "foo"], raw) as { matches: Array<{ file: string; line: number; text: string }> };
    expect(result.matches).toHaveLength(2);
    expect(result.matches[0]).toEqual({ file: "src/index.ts", line: 10, text: "import { foo }" });
  });

  it("단일파일 -n: 줄번호:내용 형태를 정확히 파싱한다", () => {
    const raw    = "26: * 주석 내용\n59:      if (x) {\n";
    const result = parseGrep("grep", ["-n", "pattern", "src/guard.ts"], raw) as { matches: Array<{ file: string; line: number; text: string }> };
    expect(result.matches).toHaveLength(2);
    expect(result.matches[0]).toEqual({ file: "", line: 26, text: " * 주석 내용" });
    expect(result.matches[1]).toEqual({ file: "", line: 59, text: "      if (x) {" });
  });

  it("-rn: 파일명:줄번호:내용 형태는 기존대로 파싱된다", () => {
    const raw    = "src/guard.ts:26: * 주석\nsrc/guard.ts:59:      if (x) {\n";
    const result = parseGrep("grep", ["-rn", "pattern", "src/"], raw) as { matches: Array<{ file: string; line: number; text: string }> };
    expect(result.matches[0]).toEqual({ file: "src/guard.ts", line: 26, text: " * 주석" });
    expect(result.matches[1]).toEqual({ file: "src/guard.ts", line: 59, text: "      if (x) {" });
  });
});
