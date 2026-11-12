/**
 * 단일 문자열 명령 렉서 시험.
 *
 * 작성자: 최진호
 * 작성일: 2026-11-12
 */

import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { expandGlobs, lexCommand, quoteArg, type LexedCommand } from "../../src/engine/command-lexer.js";

function ok(input: string): LexedCommand {
  const r = lexCommand(input);
  if (!r.ok) throw new Error(`${input}: ${r.message}`);
  return r;
}

describe("lexCommand 따옴표와 이스케이프", () => {
  it("작은따옴표 안은 글자 그대로, 큰따옴표 안은 \\ \" $ ` 만 이스케이프한다", () => {
    expect(ok(`grep 'a "b" $c' file`).args).toEqual(['a "b" $c', "file"]);
    expect(ok(`echo "say \\"hi\\" \\$x"`).args).toEqual(['say "hi" $x']);
    expect(ok(`echo a\\ b c`).args).toEqual(["a b", "c"]);
    expect(ok(`echo "a|b;c&&d>e"`).args).toEqual(["a|b;c&&d>e"]);
  });

  it("닫히지 않은 따옴표는 거절한다", () => {
    expect(lexCommand(`echo 'abc`)).toMatchObject({ ok: false, reason: "unterminated_quote" });
    expect(lexCommand(`echo "abc`)).toMatchObject({ ok: false, reason: "unterminated_quote" });
  });

  it("빈 명령은 거절한다", () => {
    expect(lexCommand("   ")).toMatchObject({ ok: false, reason: "empty_command" });
  });

  it("따옴표 밖의 # 이후는 주석이다", () => {
    expect(ok("git status # show it").args).toEqual(["status"]);
    expect(ok("echo a#b").args).toEqual(["a#b"]);
  });
});

describe("lexCommand 셸 연산자", () => {
  const refused: [string, string][] = [
    ["echo $(whoami)", "$("], ["echo `id`", "`"], ["echo $HOME", "$"], ["echo \"$HOME\"", "$"],
    ["ls > out.txt", ">"], ["ls >> out.txt", ">>"], ["cat < in.txt", "<"], ["sleep 5 &", "&"],
    ["ls; pwd", ";"], ["ls && pwd", "&&"], ["ls || pwd", "||"], ["diff <(ls a) <(ls b)", "<("],
    ["FOO=1 npm test", "="], ["ls 2> err.txt", "2>"],
  ];
  it.each(refused)("%s 는 %s 로 거절하고 대안을 준다", (input, operator) => {
    const r = lexCommand(input);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("unsupported_shell_operator");
    expect(r.operator).toBe(operator);
    expect(r.hint.length).toBeGreaterThan(10);
  });

  it("명령 앞의 허용된 대입은 그 명령의 환경 변수로 넘기고, 그 밖의 이름은 거절한다", () => {
    const r = ok("CI=1 CFLAGS='-O0 -g' make -j4");
    expect(r).toMatchObject({ cmd: "make", args: ["-j4"], env: { CI: "1", CFLAGS: "-O0 -g" } });
    const path = lexCommand("PATH=/tmp ls");
    expect(path.ok).toBe(false);
    if (!path.ok) expect(path.hint).toMatch(/CFLAGS/);
    expect(lexCommand("ls | CI=1 grep x").ok).toBe(false);
  });

  it("파이프는 단계로 나눈다", () => {
    const r = ok("ps aux | grep node | head -n 5");
    expect([r.cmd, ...r.args]).toEqual(["ps", "aux"]);
    expect(r.pipeline).toEqual([["grep", "node"], ["head", "-n", "5"]]);
  });

  it("2>&1과 2>/dev/null은 받고 표시한다", () => {
    expect(ok("npm test 2>&1 | tail -5")).toMatchObject({ stderr: "merge", pipeline: [["tail", "-5"]] });
    expect(ok("find . -name x 2>/dev/null")).toMatchObject({ stderr: "discard", args: [".", "-name", "x"] });
  });

  it("맨 앞의 cd <dir> && 는 작업 디렉터리가 된다", () => {
    const r = ok("cd src && cd engine && ls -la");
    expect(r.cwd).toBe(path.join("src", "engine"));
    expect([r.cmd, ...r.args]).toEqual(["ls", "-la"]);
  });

  it("끝나지 않은 파이프는 거절한다", () => {
    expect(lexCommand("ls |")).toMatchObject({ ok: false });
  });
});

describe("물결표와 글로브", () => {
  it("따옴표 밖 낱말 맨 앞의 ~ 만 홈으로 펼친다", () => {
    expect(ok("ls ~/x '~/y' a~b").args).toEqual([path.join(homedir(), "x"), "~/y", "a~b"]);
  });

  it("글로브는 cwd 기준으로 펼치고, 맞는 것이 없으면 그대로 둔다", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "parism-lex-"));
    try {
      for (const f of ["b.ts", "a.ts", "c.js", ".hidden.ts"]) writeFileSync(path.join(dir, f), "");
      mkdirSync(path.join(dir, "sub"));
      writeFileSync(path.join(dir, "sub", "d.ts"), "");
      expect(expandGlobs(ok("ls *.ts"), dir).args).toEqual(["a.ts", "b.ts"]);
      expect(expandGlobs(ok("ls */*.ts"), dir).args).toEqual(["sub/d.ts"]);
      expect(expandGlobs(ok("ls '*.ts'"), dir).args).toEqual(["*.ts"]);
      expect(expandGlobs(ok("ls *.py"), dir).args).toEqual(["*.py"]);
      expect(expandGlobs(ok("ls [ab].ts"), dir).args).toEqual(["a.ts", "b.ts"]);
      expect(expandGlobs(ok("ls .*.ts"), dir).args).toEqual([".hidden.ts"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("quoteArg", () => {
  it("셸에 다시 넣었을 때 같은 인자가 된다", () => {
    for (const arg of ["plain", "a b", "it's", "", "$x", "a|b"]) {
      const lexed = ok(`echo ${quoteArg(arg)}`);
      expect(lexed.args).toEqual([arg]);
    }
  });
});
