/**
 * `parism hook`: 에이전트 CLI의 훅으로 Bash 호출과 세션 종료를 Parism에 연결한다.
 *
 *   pre-tool-use   Bash 명령이 Parism 대상(파서가 있는 명령, 시험 러너·린터, 파이프 단계)이면
 *                  가드를 통과할 때 `parism exec`로 바꿔 실행하게 하고, 통과하지 못하면 사유와 함께 막는다.
 *                  Parism 대상이 아닌 명령과 렉서가 받지 않는 셸 문법은 건드리지 않는다.
 *   session-start  세션 시작 시점의 작업 공간 상태(HEAD, state_digest)를 남긴다.
 *   stop           세션이 끝나려 할 때, 시작 이후 작업 공간이 바뀌었는데 지금 상태에서 통과한 시험·빌드
 *                  영수증이 없으면 종료를 막고 무엇을 해야 하는지 알린다.
 *   install        클라이언트 설정 파일에 위 세 훅을 병합한다. 기존 훅과 다른 키는 그대로 둔다.
 *
 * 훅은 전용 설정 파일(~/.parism/hook.config.json)을 읽는다. install이 만든다. MCP 서버의 설정과 따로다.
 *
 * 작성자: 최진호
 * 작성일: 2026-11-12
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path                                       from "node:path";
import { fileURLToPath }                          from "node:url";
import { loadConfig, loadConfigMultiLayer, DEFAULT_CONFIG, DEFAULT_RECEIPTS, DEFAULT_STATS, type PrismConfig } from "../config/loader.js";
import { createRegistry }                         from "../parsers/index.js";
import { resolveRunner }                          from "../parsers/devloop/index.js";
import { checkGuard, GuardError }                 from "../engine/guard.js";
import { checkReceipts, workspaceState, type Receipt } from "../engine/receipts.js";
import { StatsLog }                               from "../engine/stats-log.js";
import { lexCommand, quoteArg, splitSequence, substituteStatus } from "../engine/command-lexer.js";
import { resolveCommand }                         from "../facade/run-pipeline.js";
import { sideEffectOf }                           from "../engine/side-effects.js";
import { parismHome }                             from "./paths.js";
import { storeFor }                               from "./receipts.js";

/** 훅 전용 설정 파일 */
export function hookConfigFile(): string {
  return path.join(parismHome(), "hook.config.json");
}

async function hookConfig(configPath: string | undefined): Promise<PrismConfig> {
  const file = configPath ?? hookConfigFile();
  return existsSync(file) ? loadConfig(file) : loadConfigMultiLayer();
}

function statsLog(config: PrismConfig): StatsLog | null {
  const stats = config.stats ?? DEFAULT_STATS;
  return stats.enabled ? new StatsLog(path.join(parismHome(), "stats"), stats.max_entries) : null;
}

// ── PreToolUse ────────────────────────────────────────────────────────────

/** 훅 입력에서 실행할 셸 명령을 꺼낸다. Claude Code는 Bash, Gemini CLI는 run_shell_command다. */
function shellCommandOf(input: Record<string, unknown>): string | undefined {
  const tool  = input.tool_name;
  const args  = input.tool_input as Record<string, unknown> | undefined;
  if (tool !== "Bash" && tool !== "run_shell_command" && tool !== "shell") return undefined;
  const command = args?.command;
  return typeof command === "string" ? command : undefined;
}

/** 이 실행 파일로 exec를 부르는 명령 앞부분. 절대 경로라 PATH와 npx 해석을 거치지 않는다. */
export function execPrefix(): string {
  const entry = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "index.js");
  return `${quoteArg(process.execPath)} ${quoteArg(entry)} exec`;
}

export type PreToolDecision =
  | { action: "pass"; reason: string }
  | { action: "rewrite"; command: string; output: Record<string, unknown> }
  | { action: "block"; reason: string; output: Record<string, unknown> };

/**
 * PreToolUse 판정. 출력(output)은 Claude Code의 hookSpecificOutput 형식이다.
 * Parism 대상은 파서가 있는 명령, 시험 러너·린터, 파이프 뒤 단계가 있는 명령이다.
 */
export function decidePreToolUse(input: Record<string, unknown>, config: PrismConfig, prefix = execPrefix()): PreToolDecision {
  const command = shellCommandOf(input);
  if (command === undefined) return { action: "pass", reason: "not a shell command" };
  if (command.startsWith(prefix)) return { action: "pass", reason: "already runs through parism exec" };
  const segments = splitSequence(command);
  if (!segments || segments.length === 0) return { action: "pass", reason: "left to the shell: unclosed quote" };

  /**
   * 명령 목록이면 조각마다 판정한다. 하나라도 렉서가 받지 않거나 허용 목록 밖의 명령이면 전체를 셸에 맡긴다.
   * 조각 일부만 Parism으로 실행하면 셸의 실행 순서와 종료 코드 규칙이 깨지기 때문이다.
   */
  const registry = createRegistry();
  let cwd    = typeof input.cwd === "string" ? input.cwd : process.cwd();
  let target = false;
  const names: string[] = [];
  let readOnly = true;
  for (const segment of segments) {
    const text  = substituteStatus(segment.text, 0, [0]);
    const lexed = lexCommand(text);
    if (lexed.ok && lexed.cmd === "cd" && lexed.pipeline.length === 0) {
      cwd = path.resolve(lexed.cwd ? path.resolve(cwd, lexed.cwd) : cwd, lexed.args[0] ?? process.env.HOME ?? "/");
      continue;
    }
    const resolved = resolveCommand("", { command: text, cwd });
    if (!resolved.ok) return { action: "pass", reason: `left to the shell: ${resolved.failure.message}` };
    names.push(resolved.cmd);
    if (sideEffectOf(resolved.cmd, resolved.args) !== "read_only") readOnly = false;
    if (registry.hasParser(resolved.cmd) || resolveRunner(resolved.cmd, resolved.args) !== null || resolved.pipeline !== undefined) target = true;
    try {
      checkGuard(resolved.cmd, resolved.args, resolved.cwd, config);
    } catch (err) {
      if (!(err instanceof GuardError)) throw err;
      /**
       * 허용 목록에 없는 명령은 Parism이 다루는 명령이 아니다. 작업 공간 밖 경로를 읽는 명령도 Parism으로 실행할 수 없을 뿐
       * 위험한 인자를 쓴 것은 아니다. 둘 다 막지 않고 셸(클라이언트의 권한 규칙)에 맡긴다.
       * 막는 것은 허용된 명령에 허용되지 않은 서브커맨드·플래그를 쓴 경우(git push, curl -d)다.
       */
      if (err.reason === "command_not_allowed") return { action: "pass", reason: `'${resolved.cmd}' is not in guard.allowed_commands` };
      if (err.reason === "path_not_allowed")    return { action: "pass", reason: `left to the shell: ${err.message}` };
      const reason = `Parism guard blocked this command: ${err.message}. ` +
        "Change the command, or ask the user to allow it in ~/.parism/hook.config.json.";
      return {
        action: "block", reason,
        output: { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason } },
      };
    }
  }
  if (!target) return { action: "pass", reason: `${names.join(", ") || "the command"} has no Parism parser` };

  const rewritten = `${prefix} -- ${quoteArg(command)}`;
  const toolInput = { ...(input.tool_input as Record<string, unknown>), command: rewritten };
  /**
   * 읽기만 하는 명령은 묻지 않고 실행한다. 파일·프로세스·네트워크를 건드리는 명령은 판정을 비워
   * 바뀐 명령에 Claude Code의 권한 규칙과 모드가 그대로 적용되게 한다. 훅이 사용자 확인 단계를 대신 없애지 않기 위해서다.
   */
  const decision = config.hook?.permission ?? (readOnly ? "allow" : undefined);
  return {
    action: "rewrite", command: rewritten,
    output: {
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        ...(decision !== undefined && {
          permissionDecision: decision,
          permissionDecisionReason: `Parism runs ${[...new Set(names)].join(", ")} through its guard and returns parsed output`,
        }),
        updatedInput: toolInput,
      },
    },
  };
}

// ── SessionStart ──────────────────────────────────────────────────────────

interface SessionBaseline {
  session_id:   string;
  cwd:          string;
  root?:        string;
  git_head?:    string;
  state_digest?: string;
  started_at:   string;
}

function sessionFile(sessionId: string): string {
  const safe = sessionId.replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 128) || "unknown";
  return path.join(parismHome(), "sessions", `${safe}.json`);
}

async function workspaceFor(config: PrismConfig, cwd: string) {
  const receipts = config.receipts ?? DEFAULT_RECEIPTS;
  return workspaceState(cwd, { untrackedMaxFiles: receipts.untracked_max_files, untrackedMaxBytes: receipts.untracked_max_bytes });
}

/** 세션 시작 시점의 작업 공간 상태를 남긴다. 이미 있으면(resume, compact) 처음 값을 유지한다. */
export async function recordSessionStart(input: Record<string, unknown>, config: PrismConfig): Promise<SessionBaseline | undefined> {
  const sessionId = typeof input.session_id === "string" ? input.session_id : undefined;
  if (!sessionId) return undefined;
  const file = sessionFile(sessionId);
  if (existsSync(file)) return JSON.parse(readFileSync(file, "utf8")) as SessionBaseline;
  const cwd   = typeof input.cwd === "string" ? input.cwd : process.cwd();
  const state = await workspaceFor(config, cwd);
  const baseline: SessionBaseline = {
    session_id: sessionId, cwd, started_at: new Date().toISOString(),
    ...(state && { root: state.root, git_head: state.git_head, state_digest: state.state_digest }),
  };
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(file, JSON.stringify(baseline), { mode: 0o600 });
  return baseline;
}

// ── Stop ──────────────────────────────────────────────────────────────────

/** 완료 확인으로 인정하는 실행: 시험 러너·린터·컴파일러, 패키지 관리자의 test·build·lint·check 스크립트, make, cargo, go */
export function isVerificationRun(r: Pick<Receipt, "cmd" | "args" | "summary">): boolean {
  if (r.summary) return true;
  if (resolveRunner(r.cmd, r.args) !== null) return true;
  const [sub, script] = r.args;
  if (["npm", "pnpm", "yarn", "bun"].includes(r.cmd)) {
    if (sub === "test" || sub === "t") return true;
    if (sub === "run" && script !== undefined && /test|build|lint|check|typecheck|verify/.test(script)) return true;
  }
  if (r.cmd === "make") return r.args.length === 0 || r.args.some(a => /^(test|check|build|all)$/.test(a));
  if (r.cmd === "cargo") return ["test", "build", "check", "clippy"].includes(sub ?? "");
  if (r.cmd === "go") return ["test", "build", "vet"].includes(sub ?? "");
  return ["pytest", "tsc", "vitest", "jest", "eslint", "mypy", "ruff"].includes(r.cmd);
}

function receiptFailure(r: Receipt): string | undefined {
  if (r.failure_reason) return `ended with ${r.failure_reason}`;
  if (r.exit_code !== 0) return `exit code ${r.exit_code}`;
  if (r.summary?.kind === "test" && (r.summary.failed > 0 || r.summary.files_failed > 0)) return `${r.summary.failed} failed test(s)`;
  if (r.summary?.kind === "diagnostics" && r.summary.errors > 0) return `${r.summary.errors} error(s)`;
  return undefined;
}

/** 영수증이 남는 실행 방법. 셸 변수나 리다이렉션이 든 명령은 Parism을 거치지 않아 영수증이 남지 않는다. */
const RECEIPT_HOW = "Results are recorded only when the command runs through Parism: run it with the Bash tool as a plain command such as `npm test` or `npx vitest run` " +
  "(;, &&, || and pipes to grep/head/tail are fine; output redirection, $VAR and $(...) send it to the shell and leave no record).";

export interface StopVerdict {
  block:   boolean;
  reason:  string;
  /** 판정 근거가 된 영수증 */
  receipt?: string;
}

/**
 * Stop 판정. 시작 이후 작업 공간이 바뀌지 않았으면 통과한다.
 * 바뀌었으면, verify.commands가 있으면 그 명령들의 영수증으로, 없으면 지금 상태에서 끝난
 * 확인 실행(isVerificationRun) 가운데 가장 최근 것으로 판정한다.
 */
export async function decideStop(input: Record<string, unknown>, config: PrismConfig): Promise<StopVerdict> {
  const cwd       = typeof input.cwd === "string" ? input.cwd : process.cwd();
  const sessionId = typeof input.session_id === "string" ? input.session_id : undefined;
  const current   = await workspaceFor(config, cwd);
  if (!current) return { block: false, reason: "not a git repository; nothing to compare" };

  const baselineFile = sessionId ? sessionFile(sessionId) : undefined;
  const baseline     = baselineFile && existsSync(baselineFile) ? JSON.parse(readFileSync(baselineFile, "utf8")) as SessionBaseline : undefined;
  if (baseline?.state_digest !== undefined) {
    if (baseline.state_digest === current.state_digest && baseline.git_head === current.git_head) {
      return { block: false, reason: "the workspace is the same as at session start" };
    }
  }

  const receipts = storeFor(config).list().filter(r => r.workspace?.root === current.root);
  const commands = config.verify?.commands ?? [];
  if (commands.length > 0) {
    const limits = config.receipts ?? DEFAULT_RECEIPTS;
    const report = await checkReceipts({
      receipts, commands, cwd,
      limits: { untrackedMaxFiles: limits.untracked_max_files, untrackedMaxBytes: limits.untracked_max_bytes },
    });
    if (report.ok) return { block: false, reason: "every verify command passed in the current workspace state" };
    const missing = report.items.filter(i => i.verdict !== "ok").map(i => `${i.command.join(" ")}: ${i.verdict} (${i.detail})`);
    return { block: true, reason: `Unverified code changes. Run and pass these before finishing: ${missing.join("; ")}` };
  }

  const runs   = receipts.filter(isVerificationRun).sort((a, b) => Date.parse(a.started_at) - Date.parse(b.started_at));
  const atNow  = runs.filter(r => r.workspace?.state_digest === current.state_digest);
  const latest = atNow.at(-1);
  if (latest) {
    const failure = receiptFailure(latest);
    if (!failure) return { block: false, reason: `${[latest.cmd, ...latest.args].join(" ")} passed in the current workspace state`, receipt: latest.id };
    return {
      block: true, receipt: latest.id,
      reason: `The last test or build run in this workspace state failed (${[latest.cmd, ...(latest.args_requested ?? latest.args)].join(" ")}: ${failure}). Fix it and run it again before finishing. ${RECEIPT_HOW}`,
    };
  }
  const stale = runs.at(-1);
  const hint  = stale
    ? `The last test or build run (${[stale.cmd, ...(stale.args_requested ?? stale.args)].join(" ")} at ${stale.started_at}) was before the latest changes.`
    : "No test or build has run in this workspace.";
  return { block: true, reason: `Unverified code changes detected since last test receipt. ${hint} Run the tests or build before completing. ${RECEIPT_HOW}` };
}

// ── install ───────────────────────────────────────────────────────────────

export type HookClient = "claude" | "gemini";

interface HookEntry { type: "command"; command: string; timeout?: number }
interface MatcherGroup { matcher?: string; hooks: HookEntry[] }

/** 클라이언트별 훅 이벤트 이름, 셸 도구 이름, 설정 파일 위치. timeout 단위는 Claude Code가 초, Gemini CLI가 밀리초다. */
const CLIENTS: Record<HookClient, { pre: string; stop: string; start: string; tool: string; timeoutUnit: number; settings: (scope: "project" | "user", cwd: string, home: string) => string }> = {
  claude: {
    pre: "PreToolUse", stop: "Stop", start: "SessionStart", tool: "Bash", timeoutUnit: 1,
    settings: (scope, cwd, home) => scope === "user" ? path.join(home, ".claude", "settings.json") : path.join(cwd, ".claude", "settings.json"),
  },
  gemini: {
    pre: "BeforeTool", stop: "AfterAgent", start: "SessionStart", tool: "run_shell_command", timeoutUnit: 1000,
    settings: (scope, cwd, home) => scope === "user" ? path.join(home, ".gemini", "settings.json") : path.join(cwd, ".gemini", "settings.json"),
  },
};

function hookCommand(event: "pre-tool-use" | "stop" | "session-start", client: HookClient): string {
  const entry = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "index.js");
  return `${quoteArg(process.execPath)} ${quoteArg(entry)} hook ${event}${client === "claude" ? "" : ` --client ${client}`}`;
}

/** 같은 parism 훅이 이미 있으면 바꾸고, 없으면 더한다. 다른 훅은 건드리지 않는다. */
function mergeGroup(groups: MatcherGroup[] | undefined, group: MatcherGroup, marker: string): MatcherGroup[] {
  const kept = (groups ?? []).map(g => ({ ...g, hooks: g.hooks.filter(h => !h.command.includes(marker)) })).filter(g => g.hooks.length > 0);
  return [...kept, group];
}

export interface InstallResult {
  settings:    string;
  hook_config: string;
  created_hook_config: boolean;
}

/**
 * 클라이언트 설정에 훅을 병합하고, 훅 전용 설정 파일이 없으면 만든다.
 * 전용 설정은 build 프로필, 영수증 켜기, 시크릿 리댁션 켜기, allowed_paths는 설치한 저장소다.
 */
export function installHooks(options: { client?: HookClient; scope?: "project" | "user"; cwd?: string; home?: string } = {}): InstallResult {
  const client   = options.client ?? "claude";
  const scope    = options.scope ?? "project";
  const cwd      = options.cwd ?? process.cwd();
  const home     = options.home ?? (process.env.HOME ?? "");
  const spec     = CLIENTS[client];
  const settings = spec.settings(scope, cwd, home);
  const current  = existsSync(settings) ? JSON.parse(readFileSync(settings, "utf8")) as Record<string, unknown> : {};
  const hooks    = { ...((current.hooks as Record<string, MatcherGroup[]> | undefined) ?? {}) };
  const marker   = " hook ";
  const t = spec.timeoutUnit;
  hooks[spec.pre]   = mergeGroup(hooks[spec.pre],   { matcher: spec.tool, hooks: [{ type: "command", command: hookCommand("pre-tool-use", client), timeout: 30 * t }] }, `index.js${marker}pre-tool-use`);
  hooks[spec.stop]  = mergeGroup(hooks[spec.stop],  { hooks: [{ type: "command", command: hookCommand("stop", client), timeout: 60 * t }] }, `index.js${marker}stop`);
  hooks[spec.start] = mergeGroup(hooks[spec.start], { hooks: [{ type: "command", command: hookCommand("session-start", client), timeout: 60 * t }] }, `index.js${marker}session-start`);
  mkdirSync(path.dirname(settings), { recursive: true });
  const tmp = `${settings}.parism-tmp`;
  writeFileSync(tmp, JSON.stringify({ ...current, hooks }, null, 2) + "\n");
  renameSync(tmp, settings);

  const hookConfigPath = hookConfigFile();
  let created = false;
  if (!existsSync(hookConfigPath)) {
    mkdirSync(path.dirname(hookConfigPath), { recursive: true, mode: 0o700 });
    writeFileSync(hookConfigPath, JSON.stringify({
      guard:    {
        profile: "build", allowed_paths: [cwd], allowed_commands: HOOK_ALLOWED_COMMANDS,
        secrets: { output_redaction_enabled: true },
      },
      receipts: { enabled: true },
    }, null, 2) + "\n", { mode: 0o600 });
    created = true;
  }
  return { settings, hook_config: hookConfigPath, created_hook_config: created };
}

/**
 * 훅 전용 설정의 허용 명령. 기본 목록에 개발 루프 도구(러너, 컴파일러, 린터, 패키지 관리자)를 더한다.
 * 이 명령들은 build 프로필 정책의 검사를 받는다.
 */
export const HOOK_ALLOWED_COMMANDS = [
  ...DEFAULT_CONFIG.guard.allowed_commands,
  "npx", "node", "yarn", "vitest", "jest", "tsc", "eslint", "pytest", "mypy", "ruff", "go", "make",
];

/** 설치된 parism 훅을 찾는다(doctor가 쓴다) */
export function installedHooks(cwd: string, home: string): { client: HookClient; scope: "project" | "user"; settings: string; events: string[] }[] {
  const found: { client: HookClient; scope: "project" | "user"; settings: string; events: string[] }[] = [];
  for (const client of Object.keys(CLIENTS) as HookClient[]) {
    for (const scope of ["project", "user"] as const) {
      const file = CLIENTS[client].settings(scope, cwd, home);
      if (!existsSync(file)) continue;
      try {
        const hooks = (JSON.parse(readFileSync(file, "utf8")) as { hooks?: Record<string, MatcherGroup[]> }).hooks ?? {};
        const events = Object.entries(hooks).filter(([, groups]) => groups.some(g => g.hooks?.some(h => / hook (pre-tool-use|stop|session-start)/.test(h.command ?? "")))).map(([e]) => e);
        if (events.length > 0) found.push({ client, scope, settings: file, events });
      } catch {
        /** 읽을 수 없는 설정 파일은 훅이 없는 것으로 본다. */
      }
    }
  }
  return found;
}

// ── 진입점 ────────────────────────────────────────────────────────────────

async function readStdin(): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks).toString("utf8").trim();
  if (text === "") return {};
  const value = JSON.parse(text) as unknown;
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

/** 훅 이벤트 하나를 처리하고 표준 출력에 쓸 JSON(없으면 undefined)을 돌려준다 */
export async function runHook(event: string, options: { config?: string; client?: HookClient } = {}): Promise<string | undefined> {
  const input  = await readStdin();
  const config = await hookConfig(options.config);
  const log    = statsLog(config);
  if (event === "pre-tool-use") {
    const decision = decidePreToolUse(input, config);
    if (decision.action === "pass") return undefined;
    const resolved = shellCommandOf(input)?.trim().split(/\s+/)[0];
    log?.record({ kind: decision.action === "rewrite" ? "hook_rewrite" : "hook_block", ...(resolved && { cmd: resolved }) });
    return JSON.stringify(options.client === "gemini" ? toGemini(decision) : decision.output);
  }
  if (event === "session-start") {
    await recordSessionStart(input, config);
    return undefined;
  }
  if (event === "stop") {
    const verdict = await decideStop(input, config);
    log?.record({ kind: verdict.block ? "stop_block" : "stop_pass" });
    if (!verdict.block) return undefined;
    return JSON.stringify({ decision: "block", reason: verdict.reason });
  }
  throw new Error(`unknown hook event '${event}': use pre-tool-use, session-start or stop`);
}

/**
 * Gemini CLI BeforeTool 훅 출력(Gemini CLI 0.51 hooks reference). 차단은 decision: "deny"와 reason,
 * 인자 바꾸기는 모델의 인자에 합쳐지는 hookSpecificOutput.tool_input이다.
 */
function toGemini(decision: Exclude<PreToolDecision, { action: "pass" }>): Record<string, unknown> {
  if (decision.action === "block") return { decision: "deny", reason: decision.reason };
  const output = decision.output.hookSpecificOutput as { updatedInput: Record<string, unknown> };
  return { decision: "allow", hookSpecificOutput: { hookEventName: "BeforeTool", tool_input: output.updatedInput } };
}
