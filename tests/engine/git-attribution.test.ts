/**
 * git 변경 귀속과 쓰기 뒤 상태 요약 시험. 실제 git 저장소에서 확인한다.
 *
 * 작성자: 최진호
 * 작성일: 2026-11-12
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { attributeReport, parseUnifiedDiff } from "../../src/engine/attribution.js";
import { gitDelta, isMutatingGit, summarizeStatus } from "../../src/engine/git-delta.js";
import { ParismEngine } from "../../src/facade/engine.js";
import { DEFAULT_CONFIG } from "../../src/config/loader.js";
import { createRegistry } from "../../src/parsers/index.js";

let repo: string;
const git = (...args: string[]) => execFileSync("git", ["-c", "user.email=t@example.invalid", "-c", "user.name=t", ...args], { cwd: repo, stdio: "pipe" }).toString();

beforeAll(() => {
  repo = mkdtempSync(path.join(tmpdir(), "parism-attr-"));
  git("init", "-q");
  mkdirSync(path.join(repo, "src"));
  mkdirSync(path.join(repo, "tests"));
  writeFileSync(path.join(repo, "src", "math.ts"), "export function add(a, b) {\n  return a + b;\n}\n\nexport function mul(a, b) {\n  return a * b;\n}\n");
  writeFileSync(path.join(repo, "tests", "math.test.ts"), 'import { add } from "../src/math.js";\nexpect(add(1, 2)).toBe(3);\n');
  writeFileSync(path.join(repo, "src", "other.ts"), "export const x = 1;\n");
  git("add", "-A");
  git("commit", "-qm", "init");
  /** 6번째 줄을 바꾸고, 새 파일을 하나 만든다 */
  writeFileSync(path.join(repo, "src", "math.ts"), "export function add(a, b) {\n  return a + b;\n}\n\nexport function mul(a, b) {\n  return a * b + 1;\n}\n");
  writeFileSync(path.join(repo, "src", "new.ts"), "export const y = 2;\n");
});

afterAll(() => rmSync(repo, { recursive: true, force: true }));

describe("parseUnifiedDiff", () => {
  it("헝크의 새 파일 줄 범위와 미리보기를 읽는다", () => {
    const files = parseUnifiedDiff([
      "diff --git a/src/a.ts b/src/a.ts", "--- a/src/a.ts", "+++ b/src/a.ts",
      "@@ -3,2 +3,3 @@ fn", "-old", "+new", "+more", "@@ -10 +11,0 @@", "-gone",
      "diff --git a/x b/x", "--- a/x", "+++ /dev/null", "@@ -1 +0,0 @@", "-x",
    ].join("\n"));
    expect([...files.keys()]).toEqual(["src/a.ts"]);
    expect(files.get("src/a.ts")!.hunks).toEqual([
      { start: 3, end: 5, preview: ["-old", "+new", "+more"] },
      { start: 11, end: 11, preview: ["-gone"] },
    ]);
  });
});

describe("attributeReport", () => {
  it("바뀐 줄, 바뀐 파일의 다른 줄, 바뀌지 않은 파일, 새 파일을 가른다", async () => {
    const report = {
      kind: "test", failures: [
        { file: "src/math.ts", line: 6, message: "boom" },
        { file: "src/math.ts", line: 2, message: "boom" },
        { file: "src/other.ts", line: 1, message: "boom" },
        { file: "src/new.ts", line: 1, message: "boom" },
        { file: "tests/math.test.ts", line: 2, message: "AssertionError\n    at tests/math.test.ts:2:1" },
        { file: "tests/math.test.ts", line: 2, message: "Error\n    at mul (src/math.ts:6:12)\n    at tests/math.test.ts:2:1" },
      ],
    };
    const out = await attributeReport(report, repo) as typeof report & { failures: Record<string, unknown>[]; attribution: Record<string, number> };
    expect(out.failures.map(f => f.attribution)).toEqual(["modified_line", "modified_file", "unmodified", "modified_line", "unmodified", "modified_line"]);
    expect(out.failures[0]!.diff_hunk_preview).toBe("-  return a * b;\n+  return a * b + 1;");
    expect(out.failures[4]!.imports_changed).toEqual(["src/math.ts"]);
    expect(out.failures[5]!.attribution_frame).toBe("src/math.ts:6");
    expect(out.attribution).toEqual({ modified_line: 3, modified_file: 1, unmodified: 2, changed_files: 2 });
  });

  it("git 저장소가 아니거나 실패가 없으면 그대로 돌려준다", async () => {
    const plain = mkdtempSync(path.join(tmpdir(), "parism-plain-"));
    const report = { kind: "test", failures: [{ file: "a.ts", line: 1 }] };
    expect(await attributeReport(report, plain)).toBe(report);
    const empty = { kind: "test", failures: [] };
    expect(await attributeReport(empty, repo)).toBe(empty);
    rmSync(plain, { recursive: true, force: true });
  });
});

describe("git 쓰기 뒤 _delta", () => {
  it("쓰기 서브커맨드만 고른다", () => {
    expect(isMutatingGit(["commit", "-m", "x"])).toBe(true);
    expect(isMutatingGit(["--no-pager", "add", "."])).toBe(true);
    expect(isMutatingGit(["branch"])).toBe(false);
    expect(isMutatingGit(["branch", "feature"])).toBe(true);
    expect(isMutatingGit(["stash", "list"])).toBe(false);
    expect(isMutatingGit(["status"])).toBe(false);
  });

  it("porcelain v2 출력을 센다", () => {
    expect(summarizeStatus([
      "# branch.oid 0123456789abcdef", "# branch.head main", "# branch.ab +2 -1",
      "1 M. N... 100644 100644 100644 a b f1", "1 .M N... 100644 100644 100644 a b f2", "1 MM N... 100644 100644 100644 a b f3",
      "u UU N... 1 2 3 4 a b c f4", "? new.txt", "",
    ].join("\n"))).toEqual({ branch: "main", head: "0123456789ab", staged_count: 2, modified_count: 2, untracked_count: 1, conflicted_count: 1, ahead: 2, behind: 1 });
  });

  it("build 프로필의 git add, commit은 실행되고 _delta가 붙는다", async () => {
    const config = structuredClone(DEFAULT_CONFIG);
    config.guard.allowed_paths = [repo];
    config.guard.profile = "build";
    const engine = new ParismEngine(config, createRegistry());
    const added  = await engine.run("", { command: "git add src/new.ts", cwd: repo });
    expect(added.ok).toBe(true);
    expect(added._delta).toMatchObject({ staged_count: 1, modified_count: 1, untracked_count: 0 });
    const commit = await engine.run("", { command: "git -c user.name=x commit -m add", cwd: repo });
    expect(commit.ok).toBe(false);
    expect(commit.failure?.kind).toBe("guard");
    git("config", "user.email", "t@example.invalid");
    git("config", "user.name", "t");
    const ok = await engine.run("", { command: "git commit -m 'add new'", cwd: repo });
    expect(ok.ok, ok.stderr.raw).toBe(true);
    expect(ok._delta).toMatchObject({ staged_count: 0, modified_count: 1 });
    expect(await gitDelta(repo)).toEqual(ok._delta);
    /** 원격 쓰기는 허용 설정 없이는 막힌다 */
    const push = await engine.run("", { command: "git push origin main", cwd: repo });
    expect(push.failure?.reason).toBe("arg_not_allowed");
    /** 설정 키는 허용 목록 안만 바꿀 수 있다 */
    expect((await engine.run("", { command: "git config core.sshCommand evil", cwd: repo })).failure?.reason).toBe("arg_not_allowed");
    expect((await engine.run("", { command: "git config user.name tester", cwd: repo })).ok).toBe(true);
  });

  it("git -C는 작업 디렉터리로 옮겨 실행하고, 옮긴 디렉터리도 허용 경로 검사를 받는다", async () => {
    const config = structuredClone(DEFAULT_CONFIG);
    config.guard.allowed_paths = [repo];
    const engine = new ParismEngine(config, createRegistry());
    const status = await engine.run("", { command: `git -C ${path.join(repo, "src")} status`, cwd: tmpdir() });
    expect(status.ok, status.failure?.message).toBe(true);
    expect(status.cwd).toBe(path.join(repo, "src"));
    const outside = await engine.run("git", { args: ["-C", tmpdir(), "status"], cwd: repo });
    expect(outside.failure?.reason).toBe("path_not_allowed");
    const gitDir = await engine.run("", { command: `git --git-dir=${path.join(repo, ".git")} log --oneline -1`, cwd: path.join(repo, "src") });
    expect(gitDir.ok, gitDir.failure?.message).toBe(true);
    expect(gitDir.cwd).toBe(repo);
  });

  it("readonly 프로필은 git 쓰기를 막는다", async () => {
    const config = structuredClone(DEFAULT_CONFIG);
    config.guard.allowed_paths = [repo];
    const engine = new ParismEngine(config, createRegistry());
    expect((await engine.run("", { command: "git add .", cwd: repo })).failure?.reason).toBe("arg_not_allowed");
  });
});
