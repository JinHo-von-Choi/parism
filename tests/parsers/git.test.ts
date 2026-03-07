import { describe, it, expect } from "vitest";
import { parseGitStatus } from "../../src/parsers/git/status.js";
import { parseGitLog }    from "../../src/parsers/git/log.js";
import { parseGitDiff }   from "../../src/parsers/git/diff.js";

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
