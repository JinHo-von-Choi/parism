import { describe, it, expect } from "vitest";
import { parseWc }   from "../../src/parsers/text/wc.js";
import { parseGrep } from "../../src/parsers/text/grep.js";
import { parseCat }  from "../../src/parsers/text/cat.js";
import { parseHead } from "../../src/parsers/text/head.js";
import { parseTail } from "../../src/parsers/text/tail.js";

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

  it("-rn: 파일명:줄번호:내용 형태는 기존대로 파싱한다", () => {
    const raw    = "src/guard.ts:26: * 주석\nsrc/guard.ts:59:      if (x) {\n";
    const result = parseGrep("grep", ["-rn", "pattern", "src/"], raw) as { matches: Array<{ file: string; line: number; text: string }> };
    expect(result.matches[0]).toEqual({ file: "src/guard.ts", line: 26, text: " * 주석" });
    expect(result.matches[1]).toEqual({ file: "src/guard.ts", line: 59, text: "      if (x) {" });
  });

  it("file:text 형태(콜론 구분)를 파싱한다", () => {
    const raw    = "src/foo.ts:import x\nsrc/bar.ts:export y\n";
    const result = parseGrep("grep", ["-r", "x"], raw) as { matches: Array<{ file: string; line: number; text: string }> };
    expect(result.matches[0].file).toBe("src/foo.ts");
    expect(result.matches[0].line).toBe(0);
    expect(result.matches[0].text).toBe("import x");
  });

  it("콜론 없는 줄은 file 빈 문자열, line 0으로 파싱한다", () => {
    const raw    = "plain line without colon\n";
    const result = parseGrep("grep", [], raw) as { matches: Array<{ file: string; line: number; text: string }> };
    expect(result.matches[0].file).toBe("");
    expect(result.matches[0].line).toBe(0);
    expect(result.matches[0].text).toBe("plain line without colon");
  });

  it("maxItems 초과 시 _summary와 truncation을 반환한다", () => {
    const raw    = Array.from({ length: 10 }, (_, i) => `file.ts:${i + 1}:line ${i}`).join("\n");
    const result = parseGrep("grep", ["-rn", "x"], raw, { maxItems: 3, format: "json" }) as {
      matches: unknown[];
      _summary: { total: number; shown: number; truncated: boolean };
    };
    expect(result.matches).toHaveLength(3);
    expect(result._summary.total).toBe(10);
    expect(result._summary.truncated).toBe(true);
  });
});

describe("parseCat()", () => {
  it("라인 배열을 반환한다", () => {
    const result = parseCat("cat", [], "line1\nline2\nline3");
    expect(result.lines).toEqual(["line1", "line2", "line3"]);
  });
});

describe("parseHead()", () => {
  it("라인 배열을 반환한다", () => {
    const result = parseHead("head", ["-n", "2"], "a\nb\nc");
    expect(result.lines).toEqual(["a", "b", "c"]);
  });
});

describe("parseTail()", () => {
  it("라인 배열을 반환한다", () => {
    const result = parseTail("tail", ["-n", "2"], "a\nb\nc");
    expect(result.lines).toEqual(["a", "b", "c"]);
  });
});
