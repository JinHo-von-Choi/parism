import { describe, it, expect } from "vitest";
import { parseWc }   from "../../src/parsers/text/wc.js";
import { parseGrep } from "../../src/parsers/text/grep.js";
import { parseCat }  from "../../src/parsers/text/cat.js";
import { parseHead } from "../../src/parsers/text/head.js";
import { parseTail } from "../../src/parsers/text/tail.js";
import { createRegistry } from "../../src/parsers/index.js";
import { UnrecognizedOutputError } from "../../src/parsers/registry.js";

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

describe("parseGrep() 형식 판정", () => {
  it("단일 파일 -n 출력은 file 없이 line만 갖는다", () => {
    expect((parseGrep("grep", ["-n", "x", "a.txt"], "12:text\n") as { matches: unknown[] }).matches[0]).toMatchObject({ line: 12, text: "text" });
  });
  it("-n 없는 다중 파일 출력의 콜론 포함 텍스트를 줄 번호로 오인하지 않는다", () => {
    expect((parseGrep("grep", ["x", "a.txt", "b.txt"], "a.txt:12:00 x\n") as { matches: unknown[] }).matches[0]).toMatchObject({ file: "a.txt", text: "12:00 x" });
  });
  it("값이 붙은 짧은 옵션(-A3, -m5)의 값은 피연산자로 세지 않는다", () => {
    for (const args of [["-A3", "x", "a.txt"], ["-m5", "x", "a.txt"], ["-nA", "3", "x", "a.txt"], ["--context", "3", "x", "a.txt"], ["-2", "x", "a.txt"]]) {
      const m = (parseGrep("grep", args, "a: b\n") as { matches: unknown[] }).matches[0];
      expect(m).toMatchObject({ file: "", text: "a: b" });
    }
  });
  it("짧은 옵션 묶음 끝의 값 옵션은 다음 인자를 값으로 받는다", () => {
    const m = (parseGrep("grep", ["-nA", "2", "x", "a.txt"], "7:a: b\n") as { matches: unknown[] }).matches[0];
    expect(m).toMatchObject({ file: "", line: 7, text: "a: b" });
  });
  it("--regexp 로 패턴을 주면 첫 피연산자도 파일이다", () => {
    expect((parseGrep("grep", ["--regexp", "x", "a.txt", "b.txt"], "a.txt:hit\n") as { matches: unknown[] }).matches[0]).toMatchObject({ file: "a.txt", text: "hit" });
    expect((parseGrep("grep", ["--regexp=x", "a.txt"], "a: b\n") as { matches: unknown[] }).matches[0]).toMatchObject({ file: "", text: "a: b" });
  });
  it("-l 은 파일 이름만 file 로 담는다", () => {
    expect((parseGrep("grep", ["-rl", "x", "."], "./a.txt\n") as { matches: unknown[] }).matches[0]).toMatchObject({ file: "./a.txt", text: "" });
  });
});

describe("parseGrep() 문맥 줄과 파일 판정", () => {
  type Rows = { matches: Array<{ file: string; line: number; text: string; byte_offset?: number; context?: true }> };
  const run = (args: string[], raw: string): Rows["matches"] => (parseGrep("grep", args, raw) as Rows).matches;

  it("-r에 파일 하나를 주면 이름 열 없이 읽는다", () => {
    expect(run(["-rn", "root", "a.txt"], "4:root:x:0:0\n")).toEqual([{ file: "", line: 4, text: "root:x:0:0" }]);
  });

  it("-r에 디렉터리 하나를 주면 모든 줄이 피연산자 경로로 시작한다", () => {
    expect(run(["-rn", "x", "sub"], "sub/a.txt:2:x one\nsub/b.txt:5:x two\n")[1]).toEqual({ file: "sub/b.txt", line: 5, text: "x two" });
    expect(run(["-r", "x", "dir with space"], "dir with space/a.txt:hit\n")[0]).toMatchObject({ file: "dir with space/a.txt", text: "hit" });
  });

  it("-r 단일 피연산자가 파일인지 디렉터리인지 출력으로 가릴 수 없으면 예외다", () => {
    expect(() => run(["-r", "x", "sub"], "sub/a.txt:hit\nplain line\n")).toThrow(UnrecognizedOutputError);
  });

  it("단일 파일 -n에서 문맥 줄은 context로 표시하고 구분자 줄은 버린다", () => {
    const raw = "7:line 7 match here\n8-line 8 filler\n--\n14:line 14 match here\n";
    expect(run(["-n", "-A1", "match", "ctx.txt"], raw)).toEqual([
      { file: "", line: 7, text: "line 7 match here" },
      { file: "", line: 8, text: "line 8 filler", context: true },
      { file: "", line: 14, text: "line 14 match here" },
    ]);
  });

  it("여러 파일 -n 문맥 줄은 일치 줄의 이름으로 이름과 번호를 가른다", () => {
    const raw = "./data-2024-01.csv:3:x\n./data-2024-01.csv-4-after\n--\n./two.txt:1:x\n";
    const rows = run(["-rn", "-A1", "x", "."], raw);
    expect(rows[1]).toEqual({ file: "./data-2024-01.csv", line: 4, text: "after", context: true });
    expect(rows[2]).toMatchObject({ file: "./two.txt", line: 1 });
  });

  it("피연산자 이름에 콜론이 있어도 이름을 그대로 쓴다", () => {
    expect(run(["-n", "colon", "odd:name.txt", "b.txt"], "odd:name.txt:1:colon\nb.txt:2:colon\n")[0]).toEqual({ file: "odd:name.txt", line: 1, text: "colon" });
  });

  it("-b 바이트 오프셋을 byte_offset으로 담는다", () => {
    expect(run(["-bn", "match", "two.txt"], "1:0:match one\n3:18:match two\n")[1]).toEqual({ file: "", line: 3, text: "match two", byte_offset: 18 });
    expect(run(["-b", "match", "two.txt"], "18:match two\n")[0]).toMatchObject({ line: 0, text: "match two", byte_offset: 18 });
  });

  it("-T는 번호 앞 공백과 본문 앞 탭을 걷어 낸다", () => {
    expect(run(["-nbT", "m", "a.txt", "b.txt"], "a.txt:     1:      0:\tmatch\n")[0]).toEqual({ file: "a.txt", line: 1, text: "match", byte_offset: 0 });
  });

  it("-Z -l은 NUL로 나뉜 파일 목록을 읽는다", () => {
    expect(run(["-Z", "-l", "m", "a", "b"], "a\0b\0").map(r => r.file)).toEqual(["a", "b"]);
  });

  it("-L은 파일 목록이다", () => {
    expect(run(["-L", "m", "a", "b"], "b\n")).toEqual([{ file: "b", line: 0, text: "" }]);
  });

  it("-d recurse는 -r처럼 이름 열을 읽는다", () => {
    const want = [{ file: "d/a.txt", line: 2, text: "match one" }];
    expect(run(["-n", "-d", "recurse", "match", "d"], "d/a.txt:2:match one\n")).toEqual(want);
    expect(run(["-n", "--directories=recurse", "match", "d"], "d/a.txt:2:match one\n")).toEqual(want);
    expect(run(["-n", "-drecurse", "match", "d"], "d/a.txt:2:match one\n")).toEqual(want);
    expect(run(["-n", "--directories", "recurse", "match"], "d/a.txt:2:match one\n")).toEqual(want);
  });

  it("-d skip과 read는 재귀하지 않는다", () => {
    expect(run(["-n", "-d", "skip", "match", "top.txt"], "1:match two\n")).toEqual([{ file: "", line: 1, text: "match two" }]);
    expect(run(["-n", "-d", "read", "match", "top.txt"], "1:match two\n")).toEqual([{ file: "", line: 1, text: "match two" }]);
    expect(run(["-n", "-d", "recurse", "-d", "skip", "match"], "1:match two\n")).toEqual([{ file: "", line: 1, text: "match two" }]);
  });

  it("-c는 이름에 콜론이 있어도 끝의 개수를 뗀다", () => {
    expect(run(["-c", "m", "a:b", "c"], "a:b:3\nc:0\n")).toEqual([{ file: "a:b", line: 0, text: "3" }, { file: "c", line: 0, text: "0" }]);
  });
});

describe("grep 계약 문맥 판정", () => {
  const unsupported = (args: string[]): boolean => createRegistry().parse("grep", args, "").parse_error?.reason === "unsupported_format";

  it("문맥 옵션은 -n이 있어야 받는다", () => {
    expect(unsupported(["-A1", "x", "f"])).toBe(true);
    expect(unsupported(["-C", "2", "x", "f"])).toBe(true);
    expect(unsupported(["-2", "x", "f"])).toBe(true);
    expect(unsupported(["-nA1", "x", "f"])).toBe(false);
    expect(unsupported(["-n", "--context=2", "x", "f"])).toBe(false);
  });

  it("-o, -c, -l과 문맥 옵션, 파일 목록이 아닌 -Z는 받지 않는다", () => {
    expect(unsupported(["-onA1", "x", "f"])).toBe(true);
    expect(unsupported(["-ncA1", "x", "f"])).toBe(true);
    expect(unsupported(["-Z", "x", "f"])).toBe(true);
    expect(unsupported(["-Zl", "x", "f"])).toBe(false);
  });

  it("-d, --directories 값은 read, skip, recurse만 받는다", () => {
    for (const v of ["read", "skip", "recurse"]) {
      expect(unsupported(["-n", "-d", v, "x", "f"])).toBe(false);
      expect(unsupported(["-n", `--directories=${v}`, "x", "f"])).toBe(false);
    }
    expect(unsupported(["-n", "-d", "other", "x", "f"])).toBe(true);
    expect(unsupported(["-n", "--directories=other", "x", "f"])).toBe(true);
    expect(unsupported(["-n", "-D", "other", "x", "f"])).toBe(true);
    expect(unsupported(["-n", "-D", "skip", "x", "f"])).toBe(false);
  });

  it("문맥 옵션 안내는 -n을 더한다", () => {
    expect(createRegistry().parse("grep", ["-A1", "x", "f"], "").parse_error?.hint?.args).toEqual(["-n", "-A1", "x", "f"]);
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
