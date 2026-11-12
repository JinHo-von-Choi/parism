/**
 * 파이프-투영 컴파일러 시험. 글자 모드 결과는 같은 입력을 실제 셸 도구에 넣은 결과와 비교한다.
 *
 * 작성자: 최진호
 * 작성일: 2026-11-12
 */

import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { applyStages, applyTextFilters, parsePipeline, rowText, toJsRegex, toProjectionStages } from "../../src/engine/pipe-compiler.js";

const INPUT = [
  "USER PID %CPU COMMAND",
  "root 1 0.0 /sbin/init",
  "alice 22 5.1 node server.js",
  "bob 7 12.5 python3 app.py",
  "alice 31 0.3 node worker.js --name=Node",
  "carol 5 0.0 bash",
  "",
].join("\n");

/** 같은 입력을 셸 파이프로 돌린 결과 */
function shell(stages: string): string {
  return execFileSync("sh", ["-c", stages], { input: INPUT, env: { ...process.env, LC_ALL: "C" } }).toString();
}

async function text(stages: string[][]): Promise<string> {
  const parsed = parsePipeline(stages);
  if (!parsed.ok) throw new Error(parsed.message);
  return applyTextFilters(INPUT, parsed.specs);
}

describe("글자 모드는 셸 도구와 같은 결과를 낸다", () => {
  const cases: [string, string[][]][] = [
    ["grep node", [["grep", "node"]]],
    ["grep -i node", [["grep", "-i", "node"]]],
    ["grep -v node", [["grep", "-v", "node"]]],
    ["grep -c node", [["grep", "-c", "node"]]],
    ["grep -E 'alice|bob'", [["grep", "-E", "alice|bob"]]],
    ["grep 'alice\\|bob'", [["grep", "alice\\|bob"]]],
    ["grep -F '%CPU'", [["grep", "-F", "%CPU"]]],
    ["grep -w node", [["grep", "-w", "node"]]],
    ["grep -m 1 alice", [["grep", "-m", "1", "alice"]]],
    ["grep '^a'", [["grep", "^a"]]],
    ["grep '[[:digit:]]\\{2\\}'", [["grep", "[[:digit:]]\\{2\\}"]]],
    ["head -n 2", [["head", "-n", "2"]]],
    ["head -3", [["head", "-3"]]],
    ["tail -n 2", [["tail", "-n", "2"]]],
    ["tail -n +3", [["tail", "-n", "+3"]]],
    ["wc -l", [["wc", "-l"]]],
    ["sort", [["sort"]]],
    ["sort -r", [["sort", "-r"]]],
    ["sort -k2 -n", [["sort", "-k2", "-n"]]],
    ["sort -k3 -rn", [["sort", "-k3", "-rn"]]],
    ["cut -d' ' -f1 | sort | uniq -c", [["cut", "-d", " ", "-f1"], ["sort"], ["uniq", "-c"]]],
    ["cut -d' ' -f1,3", [["cut", "-d", " ", "-f1,3"]]],
    ["grep node | head -n 1", [["grep", "node"], ["head", "-n", "1"]]],
  ];
  it.each(cases)("%s", async (stages, argv) => {
    expect(await text(argv)).toBe(shell(stages));
  });
});

describe("단계 해석", () => {
  it("지원하지 않는 단계와 옵션은 이유와 대안을 준다", () => {
    expect(parsePipeline([["awk", "{print $1}"]])).toMatchObject({ ok: false, stage: "awk {print $1}" });
    expect(parsePipeline([["grep", "-P", "x"]])).toMatchObject({ ok: false });
    expect(parsePipeline([["grep", "x", "file.txt"]])).toMatchObject({ ok: false });
    expect(parsePipeline([["head", "-n", "-5"]])).toMatchObject({ ok: false });
    const r = parsePipeline([["xargs", "rm"]]);
    expect(!r.ok && r.hint).toContain("query_result");
  });

  it("BRE를 JavaScript 정규식으로 옮긴다", () => {
    expect(toJsRegex("a\\(b\\)\\{2\\}", "basic")).toBe("a(b){2}");
    expect(toJsRegex("a(b)+", "basic")).toBe("a\\(b\\)\\+");
    expect(toJsRegex("a.b", "fixed")).toBe("a\\.b");
    expect(toJsRegex("\\<word\\>", "extended")).toBe("\\bword\\b");
  });
});

describe("행 모드", () => {
  const rows = [
    { user: "root", pid: 1, cpu: 0, command: "/sbin/init" },
    { user: "alice", pid: 22, cpu: 5.1, command: "node server.js" },
    { user: "bob", pid: 7, cpu: 12.5, command: "python3 app.py" },
    { user: "alice", pid: 31, cpu: 0.3, command: "node worker.js" },
  ];
  const fields = new Set(["user", "pid", "cpu", "command"]);

  it("grep, head, tail, wc -l, sort -k 필드를 행에 적용한다", async () => {
    const specs = parsePipeline([["grep", "node"], ["head", "-n", "1"]]);
    if (!specs.ok) throw new Error();
    const stages = toProjectionStages(specs.specs, fields)!;
    expect(stages).toEqual([{ op: "where_regex", pattern: "node", flags: "", negate: false }, { op: "limit", count: 1, from: "start" }]);
    expect((await applyStages(rows, stages)).rows).toEqual([rows[1]]);

    const sorted = parsePipeline([["sort", "-k", "cpu", "-rn"], ["tail", "-1"]]);
    if (!sorted.ok) throw new Error();
    expect((await applyStages(rows, toProjectionStages(sorted.specs, fields)!)).rows).toEqual([rows[0]]);

    const count = parsePipeline([["grep", "-v", "alice"], ["wc", "-l"]]);
    if (!count.ok) throw new Error();
    expect((await applyStages(rows, toProjectionStages(count.specs, fields)!)).count).toBe(2);
  });

  it("행으로 옮길 수 없는 단계가 있으면 행 모드를 쓰지 않는다", () => {
    for (const argv of [[["sort", "-k2"]], [["cut", "-f1"]], [["grep", "-x", "a"]], [["wc", "-l"], ["head", "-1"]]]) {
      const specs = parsePipeline(argv);
      if (!specs.ok) throw new Error();
      expect(toProjectionStages(specs.specs, fields)).toBeUndefined();
    }
  });

  it("행의 글자는 원시 값을 공백으로 잇는다", () => {
    expect(rowText({ a: "x\ny", b: 2, c: [true, { d: "z" }], e: null })).toBe("x y 2 true z");
  });
});
