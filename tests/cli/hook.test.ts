/**
 * `parism hook` 판정 시험. 실제 git 저장소와 실제 실행(parism exec)으로 영수증을 남기고 Stop 판정을 확인한다.
 *
 * 작성자: 최진호
 * 작성일: 2026-11-12
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { decidePreToolUse, decideStop, fromAgy, installHooks, isVerificationRun, recordSessionStart, HOOK_ALLOWED_COMMANDS } from "../../src/cli/hook.js";
import { execCommand } from "../../src/cli/exec.js";
import { DEFAULT_CONFIG, type PrismConfig } from "../../src/config/loader.js";

let repo: string;
let home: string;
let saved: string | undefined;
let config: PrismConfig;
const PREFIX = "node /x/index.js exec";

const git = (...args: string[]) => execFileSync("git", ["-c", "user.email=t@example.invalid", "-c", "user.name=t", ...args], { cwd: repo, stdio: "pipe" });
const pre = (command: string) => decidePreToolUse({ tool_name: "Bash", cwd: repo, tool_input: { command, description: "d" } }, config, PREFIX);

beforeAll(() => {
  repo = mkdtempSync(path.join(tmpdir(), "parism-hook-"));
  home = mkdtempSync(path.join(tmpdir(), "parism-hook-home-"));
  saved = process.env.PARISM_HOME;
  process.env.PARISM_HOME = home;
  git("init", "-q");
  writeFileSync(path.join(repo, "a.txt"), "one\n");
  git("add", "-A");
  git("commit", "-qm", "init");
  config = structuredClone(DEFAULT_CONFIG);
  config.guard.allowed_paths    = [repo];
  config.guard.profile          = "build";
  config.guard.allowed_commands = HOOK_ALLOWED_COMMANDS;
  config.receipts = { ...config.receipts!, enabled: true };
  writeFileSync(path.join(home, "hook.config.json"), JSON.stringify({ guard: { profile: "build", allowed_paths: [repo], allowed_commands: HOOK_ALLOWED_COMMANDS }, receipts: { enabled: true } }));
});

afterAll(() => {
  if (saved === undefined) delete process.env.PARISM_HOME;
  else process.env.PARISM_HOME = saved;
  rmSync(repo, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

describe("PreToolUse", () => {
  it("파서가 있는 명령은 parism exec로 바꾸고 다른 입력 필드는 그대로 둔다", () => {
    const d = pre("git status");
    expect(d.action).toBe("rewrite");
    if (d.action !== "rewrite") return;
    expect(d.command).toBe(`${PREFIX} -- 'git status'`);
    expect(d.output).toMatchObject({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow", updatedInput: { command: d.command, description: "d" } } });
  });

  it("읽기 전용이 아닌 명령은 권한 판정을 비워 클라이언트의 권한 규칙을 따른다", () => {
    const d = pre("npm test");
    expect(d.action).toBe("rewrite");
    if (d.action !== "rewrite") return;
    const out = d.output.hookSpecificOutput as Record<string, unknown>;
    expect(out).not.toHaveProperty("permissionDecision");
    expect(out.updatedInput).toMatchObject({ command: d.command });
  });

  it("명령 목록과 파이프도 조각이 모두 렉서와 가드를 통과하면 바꾼다", () => {
    expect(pre("ls -la && git status; echo ---").action).toBe("rewrite");
    expect(pre("git log --oneline | head -5").action).toBe("rewrite");
    expect(pre("npm test 2>&1 | tail -20; echo \"exit: $?\"").action).toBe("rewrite");
  });

  it("허용된 명령에 허용되지 않은 인자를 쓰면 막는다", () => {
    const d = pre("git push origin main");
    expect(d.action).toBe("block");
    if (d.action !== "block") return;
    expect(d.output).toMatchObject({ hookSpecificOutput: { permissionDecision: "deny" } });
    expect(d.reason).toMatch(/push/);
  });

  it("agy 입력은 CommandLine을 명령으로, args.Cwd를 작업 디렉터리로, conversationId를 세션으로 읽는다", () => {
    const input = fromAgy({
      conversationId: "c1", cwd: "/elsewhere", hookEventName: "PreToolUse",
      toolCall: { id: "t1", name: "run_command", args: { CommandLine: "git status", Cwd: repo } },
    });
    expect(input).toMatchObject({ session_id: "c1", cwd: repo, tool_name: "Bash", tool_input: { command: "git status" } });
    expect(decidePreToolUse(input, config, PREFIX)).toMatchObject({ action: "rewrite", command: `${PREFIX} -- 'git status'` });
  });

  it("Parism 대상이 아니거나 셸 문법이 필요한 명령은 건드리지 않는다", () => {
    for (const command of ["python3 -c 'print(1)'", "ls > out.txt", "echo $HOME", "cat /etc/hostname", "rm -rf build"]) {
      expect(pre(command).action, command).toBe("pass");
    }
    expect(pre(`${PREFIX} -- 'git status'`).action).toBe("pass");
    expect(decidePreToolUse({ tool_name: "Read", tool_input: { file_path: "x" } }, config, PREFIX).action).toBe("pass");
  });
});

describe("parism exec", () => {
  it("명령 목록을 셸 규칙대로 실행하고 $?와 PIPESTATUS를 바꾼다", async () => {
    const r = await execCommand("git status --porcelain=v1; ls nope || echo \"fallback $?\"", { cwd: repo, config: path.join(home, "hook.config.json") });
    expect(r.stdout).toContain("fallback 2");
    expect(r.exitCode).toBe(0);
    const p = await execCommand("git log --oneline | head -1; echo \"status ${PIPESTATUS[0]}\"", { cwd: repo, config: path.join(home, "hook.config.json") });
    expect(p.stdout).toMatch(/status 0/);
  });

  it("cd 조각은 다음 조각의 작업 디렉터리를 바꾼다", async () => {
    mkdirSync(path.join(repo, "sub"), { recursive: true });
    writeFileSync(path.join(repo, "sub", "b.txt"), "b\n");
    const r = await execCommand("cd sub && cat b.txt", { cwd: repo, config: path.join(home, "hook.config.json") });
    expect(r.stdout).toBe("b\n");
    rmSync(path.join(repo, "sub"), { recursive: true, force: true });
  });
});

describe("Stop", () => {
  const session = { session_id: "s-test", cwd: "" };

  it("세션 시작 뒤 바뀐 것이 없으면 통과한다", async () => {
    session.cwd = repo;
    await recordSessionStart(session, config);
    expect(existsSync(path.join(home, "sessions", "s-test.json"))).toBe(true);
    expect(await decideStop(session, config)).toMatchObject({ block: false });
  });

  it("바뀌었는데 확인 실행이 없으면 막고, 통과한 실행이 있으면 통과한다", async () => {
    writeFileSync(path.join(repo, "a.txt"), "two\n");
    const blocked = await decideStop(session, config);
    expect(blocked.block).toBe(true);
    expect(blocked.reason).toMatch(/No test or build has run/);

    /** 확인 실행은 parism exec를 거쳐 영수증을 남긴다. 여기서는 git diff --exit-code를 make 대신 쓴다. */
    writeFileSync(path.join(repo, "package.json"), JSON.stringify({ scripts: { test: "node -e \"process.exit(0)\"" } }));
    const run = await execCommand("npm test", { cwd: repo, config: path.join(home, "hook.config.json") });
    expect(run.exitCode, run.stderr).toBe(0);
    expect(await decideStop(session, config)).toMatchObject({ block: false });

    /** 확인한 뒤 다시 고치면 막는다 */
    writeFileSync(path.join(repo, "a.txt"), "three\n");
    const stale = await decideStop(session, config);
    expect(stale.block).toBe(true);
    expect(stale.reason).toMatch(/was before the latest changes/);
  });

  it("지금 상태의 마지막 확인 실행이 실패했으면 막는다", async () => {
    writeFileSync(path.join(repo, "package.json"), JSON.stringify({ scripts: { test: "node -e \"process.exit(3)\"" } }));
    const run = await execCommand("npm test", { cwd: repo, config: path.join(home, "hook.config.json") });
    expect(run.exitCode).toBe(3);
    const failed = await decideStop(session, config);
    expect(failed.block).toBe(true);
    expect(failed.reason).toMatch(/failed .*exit code 3/);
  });

  it("확인 실행으로 인정하는 명령", () => {
    expect(isVerificationRun({ cmd: "npm", args: ["test"] })).toBe(true);
    expect(isVerificationRun({ cmd: "npm", args: ["run", "typecheck"] })).toBe(true);
    expect(isVerificationRun({ cmd: "npx", args: ["vitest", "run"] })).toBe(true);
    expect(isVerificationRun({ cmd: "cargo", args: ["build"] })).toBe(true);
    expect(isVerificationRun({ cmd: "git", args: ["status"] })).toBe(false);
    expect(isVerificationRun({ cmd: "npm", args: ["run", "dev"] })).toBe(false);
  });
});

describe("install", () => {
  it("기존 설정과 다른 훅을 지키며 병합하고, 다시 실행해도 중복되지 않는다", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "parism-install-"));
    mkdirSync(path.join(dir, ".claude"));
    writeFileSync(path.join(dir, ".claude", "settings.json"), JSON.stringify({
      model: "x", hooks: { PreToolUse: [{ matcher: "Edit", hooks: [{ type: "command", command: "other-hook" }] }] },
    }));
    installHooks({ cwd: dir, home: dir });
    installHooks({ cwd: dir, home: dir });
    const settings = JSON.parse(readFileSync(path.join(dir, ".claude", "settings.json"), "utf8"));
    expect(settings.model).toBe("x");
    expect(settings.hooks.PreToolUse).toHaveLength(2);
    expect(settings.hooks.PreToolUse[0].hooks[0].command).toBe("other-hook");
    expect(settings.hooks.PreToolUse[1]).toMatchObject({ matcher: "Bash" });
    expect(settings.hooks.Stop).toHaveLength(1);
    expect(settings.hooks.SessionStart).toHaveLength(1);
    rmSync(dir, { recursive: true, force: true });
  });

  it("Gemini CLI는 BeforeTool·AfterAgent 이벤트와 밀리초 timeout으로 쓴다", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "parism-install-g-"));
    installHooks({ client: "gemini", cwd: dir, home: dir });
    const settings = JSON.parse(readFileSync(path.join(dir, ".gemini", "settings.json"), "utf8"));
    expect(settings.hooks.BeforeTool[0]).toMatchObject({ matcher: "run_shell_command", hooks: [{ timeout: 30_000 }] });
    expect(settings.hooks.BeforeTool[0].hooks[0].command).toMatch(/hook pre-tool-use --client gemini$/);
    expect(settings.hooks.AfterAgent[0].hooks[0]).toMatchObject({ timeout: 60_000 });
    rmSync(dir, { recursive: true, force: true });
  });

  it("agy는 .agents/hooks.json의 parism 이름 아래에 쓰고 다른 이름의 훅은 그대로 둔다", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "parism-install-a-"));
    mkdirSync(path.join(dir, ".agents"));
    writeFileSync(path.join(dir, ".agents", "hooks.json"), JSON.stringify({ lint: { PostToolUse: [{ matcher: "*", hooks: [{ command: "lint.sh" }] }] } }));
    installHooks({ client: "agy", cwd: dir, home: dir });
    installHooks({ client: "agy", cwd: dir, home: dir });
    const hooks = JSON.parse(readFileSync(path.join(dir, ".agents", "hooks.json"), "utf8"));
    expect(hooks.lint.PostToolUse[0].hooks[0].command).toBe("lint.sh");
    expect(hooks.parism.PreToolUse).toEqual([{ matcher: "run_command", hooks: [expect.objectContaining({ timeout: 30 })] }]);
    expect(hooks.parism.Stop).toEqual([expect.objectContaining({ type: "command", timeout: 60 })]);
    expect(hooks.parism.Stop[0].command).toMatch(/hook stop --client agy$/);
    rmSync(dir, { recursive: true, force: true });
  });
});
