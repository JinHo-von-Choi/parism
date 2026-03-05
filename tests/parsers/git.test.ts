import { describe, it, expect } from "vitest";
import { parseGitStatus } from "../../src/parsers/git/status.js";
import { parseGitLog }    from "../../src/parsers/git/log.js";

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
