import { describe, it, expect } from "vitest";
import { parseGitStatus } from "../../src/parsers/git/status.js";
import { parseGitLog }    from "../../src/parsers/git/log.js";
import { parseGitDiff }   from "../../src/parsers/git/diff.js";
import { unquoteGitPath } from "../../src/parsers/git/paths.js";
import { createRegistry } from "../../src/parsers/index.js";

describe("parseGitStatus()", () => {
  const statusOutput = [
    "On branch main",
    "Your branch is up to date with 'origin/main'.",
    "",
    "Changes not staged for commit:",
    "  (use \"git add <file>...\" to update what will be committed)",
    "",
    "\tmodified:   src/index.ts",
    "\tmodified:   tests/server.test.ts",
    "",
    "Untracked files:",
    "  (use \"git add <file>...\" to include in what will be committed)",
    "",
    "\tdocs/",
  ].join("\n");

  it("브랜치명을 파싱한다", () => {
    const result = parseGitStatus("git", ["status"], statusOutput) as { branch: string };
    expect(result.branch).toBe("main");
  });

  it("수정된 파일 목록을 파싱한다", () => {
    const result = parseGitStatus("git", ["status"], statusOutput) as {
      modified: string[];
      untracked: string[];
    };
    expect(result.modified).toContain("src/index.ts");
    expect(result.untracked).toContain("docs/");
  });
});

describe("parseGitDiff()", () => {
  const diffOutput = [
    "diff --git a/src/server.ts b/src/server.ts",
    "index 4a2f3b1..9c8e7d0 100644",
    "--- a/src/server.ts",
    "+++ b/src/server.ts",
    "@@ -1,18 +1,25 @@",
    "-import { Server } from \"@modelcontextprotocol/sdk/server/index.js\";",
    "+import { Server, type ServerOptions } from \"@modelcontextprotocol/sdk/server/index.js\";",
    " import { StdioServerTransport } from \"@modelcontextprotocol/sdk/server/stdio.js\";",
    "+import { Guard } from \"./guard.js\";",
    " ",
    " const VERSION = \"0.1.6\";",
    "+const DEFAULT_TIMEOUT = 30_000;",
    " ",
    "-export function createServer(): Server {",
    "-  return new Server({ name: \"parism\", version: VERSION });",
    "+export function createServer(opts?: ServerOptions): Server {",
    "+  const guard = new Guard();",
    "+  return new Server({ name: \"parism\", version: VERSION }, opts);",
    " }",
    "+",
    "+export { Guard };",
    "diff --git a/src/guard.ts b/src/guard.ts",
    "index 7b3a2c0..1f4e8b5 100644",
    "--- a/src/guard.ts",
    "+++ b/src/guard.ts",
    "@@ -45,7 +45,14 @@ export class Guard {",
    "   }",
    " ",
    "-  check(cmd: string): boolean {",
    "-    return this.allowlist.has(cmd);",
    "+  check(cmd: string, args: string[]): boolean {",
    "+    if (!this.allowlist.has(cmd)) return false;",
    "+    const blocked = this.blockedPatterns.some(p => args.some(a => p.test(a)));",
    "+    return !blocked;",
    "   }",
    "+",
    "+  addPattern(pattern: RegExp): void {",
    "+    this.blockedPatterns.push(pattern);",
    "+  }",
    " }",
  ].join("\n");

  it("hunk count 생략 시 1로 파싱 (@@ -1 +1 @@)", () => {
    const minimal = [
      "diff --git a/a b/a",
      "--- a/a",
      "+++ b/a",
      "@@ -1 +1 @@",
      "+new",
    ].join("\n");
    const result = parseGitDiff("git", ["diff"], minimal) as {
      files: Array<{ hunks: Array<{ count_a: number; count_b: number }> }>;
    };
    expect(result.files[0].hunks[0].count_a).toBe(1);
    expect(result.files[0].hunks[0].count_b).toBe(1);
  });

  it("MAX_HUNKS_PER_FILE 초과 시 _truncated", () => {
    const hunks = Array.from({ length: 55 }, (_, i) =>
      `@@ -${i},1 +${i},1 @@\n+line${i}\n`,
    ).join("");
    const raw = "diff --git a/x b/x\n--- a/x\n+++ b/x\n" + hunks;
    const result = parseGitDiff("git", ["diff"], raw) as { _truncated?: boolean; _summary?: string };
    expect(result._truncated).toBe(true);
    expect(result._summary).toBe("too large to parse");
  });

  it("files_changed와 files(hunks)를 파싱한다", () => {
    const result = parseGitDiff("git", ["diff"], diffOutput) as {
      files_changed: string[];
      files: Array<{ path: string; hunks: Array<{ start_a: number; count_a: number; start_b: number; count_b: number; lines: string[] }> }>;
    };
    expect(result.files_changed).toContain("src/server.ts");
    expect(result.files_changed).toContain("src/guard.ts");
    expect(result.files).toHaveLength(2);
    expect(result.files![0].path).toBe("src/server.ts");
    expect(result.files![0].hunks).toHaveLength(1);
    expect(result.files![0].hunks[0]).toMatchObject({ start_a: 1, count_a: 18, start_b: 1, count_b: 25 });
    expect(result.files![0].hunks[0].lines.some((l) => l.startsWith("+"))).toBe(true);
    expect(result.files![0].hunks[0].lines.some((l) => l.startsWith("-"))).toBe(true);
  });
});

describe("parseGitLog()", () => {
  const logOutput = [
    "abc1234 feat: add executor",
    "def5678 chore: init project",
  ].join("\n");

  it("커밋 목록을 파싱한다 (--oneline)", () => {
    const result = parseGitLog("git", ["log", "--oneline"], logOutput) as {
      commits: Array<{ hash: string; message: string }>;
    };
    expect(result.commits).toHaveLength(2);
    expect(result.commits[0]).toEqual({ hash: "abc1234", message: "feat: add executor" });
  });
});

describe("unquoteGitPath()", () => {
  it("8진 이스케이프를 UTF-8 경로로 되돌린다", () => {
    expect(unquoteGitPath("\"n\\303\\251w.txt\"")).toBe("néw.txt");
    expect(unquoteGitPath("\"quote\\\"d\\ttab\"")).toBe("quote\"d\ttab");
  });

  it("따옴표가 없는 경로는 그대로 둔다", () => {
    expect(unquoteGitPath("sp ace.txt")).toBe("sp ace.txt");
  });
});

describe("parseGitStatus() 구획", () => {
  it("이름 바꾸기를 old와 new로 가르고 staged에는 새 경로를 둔다", () => {
    const raw = [
      "On branch main",
      "Changes to be committed:",
      "  (use \"git restore --staged <file>...\" to unstage)",
      "\tnew file:   added.txt",
      "\trenamed:    ren.txt -> renamed.txt",
      "\trenamed:    \"a b.txt\" -> \"c\\303\\251.txt\"",
    ].join("\n");
    const r = parseGitStatus("git", ["status"], raw);
    expect(r.staged).toEqual(["added.txt", "renamed.txt", "cé.txt"]);
    expect(r.renamed).toEqual([{ old: "ren.txt", new: "renamed.txt" }, { old: "a b.txt", new: "cé.txt" }]);
  });

  it("따옴표 경로를 풀고 표시 문구는 경로에 넣지 않는다", () => {
    const raw = [
      "On branch main",
      "Changes not staged for commit:",
      "\tmodified:   \"n\\303\\251w.txt\"",
      "\tmodified:   vendor/lib (new commits)",
      "\tdeleted:    gone.txt",
    ].join("\n");
    expect(parseGitStatus("git", ["status"], raw).modified).toEqual(["néw.txt", "vendor/lib", "gone.txt"]);
  });

  it("detached HEAD는 branch를 HEAD로 두고 가리키는 대상을 남긴다", () => {
    const r = parseGitStatus("git", ["status"], "HEAD detached at ada9e43\nnothing to commit, working tree clean");
    expect(r).toMatchObject({ branch: "HEAD", detached: true, detached_at: "ada9e43" });
  });

  it("무시된 파일은 untracked와 따로 담는다", () => {
    const raw = [
      "On branch main",
      "Untracked files:",
      "\tuntracked.txt",
      "",
      "Ignored files:",
      "  (use \"git add -f <file>...\" to include in what will be committed)",
      "\tbuild/",
      "\tdebug.log",
    ].join("\n");
    const r = parseGitStatus("git", ["status", "--ignored"], raw);
    expect(r.untracked).toEqual(["untracked.txt"]);
    expect(r.ignored).toEqual(["build/", "debug.log"]);
  });

  it("--ignored의 traditional, matching, no 값을 받는다", () => {
    const reg = createRegistry();
    for (const v of ["", "=traditional", "=matching", "=no"]) {
      expect(reg.parse("git", ["status", `--ignored${v}`], "On branch main\n").parse_error).toBeUndefined();
    }
  });

  it("병합 충돌 항목을 unmerged에 담는다", () => {
    const raw = ["On branch main", "Unmerged paths:", "\tboth modified:   f.txt"].join("\n");
    expect(parseGitStatus("git", ["status"], raw)).toMatchObject({ unmerged: ["f.txt"], staged: [], modified: [] });
  });

  it("-v 출력의 diff 본문은 구획으로 읽지 않는다", () => {
    const raw = ["On branch main", "Changes not staged for commit:", "\tmodified:   a.txt", "", "diff --git a/a.txt b/a.txt", "@@ -1 +1 @@", "-x", "+y"].join("\n");
    expect(parseGitStatus("git", ["status", "-v"], raw)).toMatchObject({ modified: ["a.txt"], untracked: [] });
  });
});

describe("parseGitDiff() 파일 머리", () => {
  it("새 파일과 삭제 파일을 files_changed에 넣는다", () => {
    const raw = [
      "diff --git a/added.txt b/added.txt", "new file mode 100644", "index 0000000..d5f7fc3", "--- /dev/null", "+++ b/added.txt", "@@ -0,0 +1 @@", "+added",
      "diff --git a/del.txt b/del.txt", "deleted file mode 100644", "index 8510665..0000000", "--- a/del.txt", "+++ /dev/null", "@@ -1 +0,0 @@", "-four",
    ].join("\n");
    const r = parseGitDiff("git", ["diff"], raw);
    expect(r.files_changed).toEqual(["added.txt", "del.txt"]);
    expect(r.files!.map(f => f.status)).toEqual(["added", "deleted"]);
  });

  it("이름 바꾸기는 새 경로를 path로, 원래 경로를 old_path로 담는다", () => {
    const raw = ["diff --git a/old.txt b/new-name.txt", "similarity index 100%", "rename from old.txt", "rename to new-name.txt"].join("\n");
    const r = parseGitDiff("git", ["diff", "-M"], raw);
    expect(r.files_changed).toEqual(["new-name.txt"]);
    expect(r.files![0]).toMatchObject({ path: "new-name.txt", old_path: "old.txt", status: "renamed", hunks: [] });
  });

  it("따옴표 경로와 공백이 든 경로를 푼다", () => {
    const raw = [
      "diff --git \"a/caf\\303\\251.txt\" \"b/caf\\303\\251.txt\"", "index 4ae8ef0..5001395 100644", "--- \"a/caf\\303\\251.txt\"", "+++ \"b/caf\\303\\251.txt\"", "@@ -1 +1,2 @@", " u", "+x",
      "diff --git a/sp ace.txt b/sp ace.txt", "index ffe2fce..6e60b97 100644", "--- a/sp ace.txt\t", "+++ b/sp ace.txt\t", "@@ -1 +1,2 @@", " six", "+more",
    ].join("\n");
    expect(parseGitDiff("git", ["diff"], raw).files_changed).toEqual(["café.txt", "sp ace.txt"]);
  });

  it("내용이 없는 변경(바이너리, 모드)은 diff --git 줄에서 경로를 얻는다", () => {
    const raw = ["diff --git a/blob.bin b/blob.bin", "index 1..2 100644", "Binary files a/blob.bin and b/blob.bin differ",
      "diff --git a/run.sh b/run.sh", "old mode 100644", "new mode 100755"].join("\n");
    const r = parseGitDiff("git", ["diff"], raw);
    expect(r.files_changed).toEqual(["blob.bin", "run.sh"]);
    expect(r.files![0]!.binary).toBe(true);
    expect(r.files![1]!.status).toBe("modified");
  });

  it("--no-prefix 출력은 접두를 떼지 않는다", () => {
    const raw = ["diff --git a/x.txt a/x.txt", "--- a/x.txt", "+++ a/x.txt", "@@ -1 +1 @@", "-a", "+b"].join("\n");
    expect(parseGitDiff("git", ["diff", "--no-prefix"], raw).files_changed).toEqual(["a/x.txt"]);
  });
});

describe("parseGitLog() 작성자와 날짜", () => {
  it("탭으로 나눈 해시, 작성자, 작성 시각, 제목 형식을 읽는다", () => {
    const raw = "abc1234\tAlice Kim\t2026-10-03T06:00:00+09:00\tfix: a\tb\ndef5678\tBob\t2026-10-02T01:02:03Z\tsecond\n";
    const r   = parseGitLog("git", ["log", "--format=%h%x09%an%x09%aI%x09%s"], raw);
    expect(r.commits).toEqual([
      { hash: "abc1234", author: "Alice Kim", date: "2026-10-03T06:00:00+09:00", message: "fix: a\tb" },
      { hash: "def5678", author: "Bob", date: "2026-10-02T01:02:03Z", message: "second" },
    ]);
  });

  it("작성자와 날짜 형식을 --format과 --pretty=format:으로 받는다", () => {
    const reg = createRegistry();
    for (const a of ["--format=%h%x09%an%x09%aI%x09%s", "--format=%H%x09%an%x09%aI%x09%s", "--pretty=format:%h%x09%an%x09%aI%x09%s"]) {
      const r = reg.parse("git", ["log", a], "abc1234\tAlice\t2026-10-03T06:00:00+09:00\tfirst\n");
      expect(r.parse_error).toBeUndefined();
      expect(r.parsed).toMatchObject({ commits: [{ hash: "abc1234", author: "Alice", message: "first" }] });
    }
    expect(reg.parse("git", ["log", "--format=%h%x09%an%x09%s"], "").parse_error?.reason).toBe("unsupported_format");
  });
});

describe("parseGitLog() 참조", () => {
  it("--decorate=full 꼬리표를 refs로 가르고 message는 제목만 둔다", () => {
    const raw = ["3166aa7 (HEAD -> refs/heads/main, tag: refs/tags/v1.0) third: colon subject (with parens)", "fd44bc8 add later file"].join("\n");
    const r = parseGitLog("git", ["log", "--oneline", "--decorate=full"], raw);
    expect(r.commits[0]).toEqual({ hash: "3166aa7", message: "third: colon subject (with parens)", refs: ["HEAD -> refs/heads/main", "tag: refs/tags/v1.0"] });
    expect(r.commits[1]).toEqual({ hash: "fd44bc8", message: "add later file" });
  });

  it("--decorate=full에서 꼬리표 없는 커밋의 괄호 제목은 제목으로 둔다", () => {
    const raw = [
      "7434367 (HEAD -> refs/heads/main, refs/remotes/origin/main, refs/remotes/origin/HEAD, refs/heads/gone-branch) fourth",
      "3a7ab88 (tag: refs/tags/v0.1, refs/heads/feature) plain third",
      "603547c (docs, fix) second",
      "a36b3b5 (wip) first",
    ].join("\n") + "\n";
    const r = parseGitLog("git", ["log", "--oneline", "--decorate=full"], raw);
    expect(r.commits[0]!.refs).toEqual(["HEAD -> refs/heads/main", "refs/remotes/origin/main", "refs/remotes/origin/HEAD", "refs/heads/gone-branch"]);
    expect(r.commits[1]).toEqual({ hash: "3a7ab88", message: "plain third", refs: ["tag: refs/tags/v0.1", "refs/heads/feature"] });
    expect(r.commits[2]).toEqual({ hash: "603547c", message: "(docs, fix) second" });
    expect(r.commits[3]).toEqual({ hash: "a36b3b5", message: "(wip) first" });
  });

  it("detached HEAD 꼬리표(HEAD)와 꼬리표 뒤의 괄호 제목을 가른다", () => {
    const r = parseGitLog("git", ["log", "--oneline", "--decorate=full"], "a36b3b5 (HEAD, refs/heads/side) (wip) first\n");
    expect(r.commits[0]).toEqual({ hash: "a36b3b5", message: "(wip) first", refs: ["HEAD", "refs/heads/side"] });
  });

  it("마지막 --no-decorate가 꼬리표 해석을 끈다", () => {
    const r = parseGitLog("git", ["log", "--oneline", "--decorate=full", "--no-decorate"], "a36b3b5 (refs/heads/x) first\n");
    expect(r.commits[0]).toEqual({ hash: "a36b3b5", message: "(refs/heads/x) first" });
  });

  it("짧은 꼬리표(--decorate, --decorate=short)는 브랜치 이름과 괄호 제목을 가를 수 없어 받지 않고 --decorate=full을 안내한다", () => {
    const reg = createRegistry();
    for (const d of ["--decorate", "--decorate=short"]) {
      const r = reg.parse("git", ["log", "--oneline", d], "a36b3b5 (wip) first\n");
      expect(r.parse_error?.reason).toBe("unsupported_format");
      expect(r.parse_error?.hint?.args).toEqual(["log", "--oneline", "--decorate=full"]);
    }
    expect(reg.parse("git", ["log", "--oneline", "--decorate=full"], "a36b3b5 (wip) first\n").parse_error).toBeUndefined();
  });

  it("--decorate가 없으면 괄호로 시작하는 제목을 건드리지 않는다", () => {
    const r = parseGitLog("git", ["log", "--oneline"], "abc1234 (wip) draft");
    expect(r.commits[0]).toEqual({ hash: "abc1234", message: "(wip) draft" });
  });

  it("제목이 빈 커밋도 한 행으로 센다", () => {
    expect(parseGitLog("git", ["log", "--oneline"], "abc1234\ndef5678 x").commits).toHaveLength(2);
  });
});
