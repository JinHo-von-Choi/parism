/**
 * `parism doctor`: 설정과 설치 상태를 점검하고 고칠 점을 알린다. 명령을 실행하지 않는다(git과 네이티브 바이너리 확인은 한다).
 *
 * 작성자: 최진호
 * 작성일: 2026-11-12
 */

import { existsSync, readFileSync } from "node:fs";
import os                           from "node:os";
import path                         from "node:path";
import { loadConfig, loadConfigMultiLayer, DEFAULT_RECEIPTS, type PrismConfig } from "../config/loader.js";
import { resolveNativeBinary }     from "../engine/regex-native.js";
import { probeAll }                from "../engine/availability.js";
import { installedHooks, hookConfigFile } from "./hook.js";
import { readStats }               from "./stats.js";
import { parismHome }              from "./paths.js";
import { signingKeyFor }           from "./receipts.js";

export type CheckLevel = "ok" | "warn" | "error" | "info";

export interface DoctorCheck {
  id:      string;
  level:   CheckLevel;
  message: string;
  /** 고치는 방법 */
  fix?:    string;
}

export interface DoctorReport {
  checks: DoctorCheck[];
  ok:     boolean;
}

/** 설정 파일에 output_patterns가 빈 배열로 적혀 있는지 */
function emptyOutputPatterns(file: string): boolean {
  try {
    const json = JSON.parse(readFileSync(file, "utf8")) as { guard?: { secrets?: { output_patterns?: unknown } } };
    const patterns = json.guard?.secrets?.output_patterns;
    return Array.isArray(patterns) && patterns.length === 0;
  } catch {
    return false;
  }
}

function configChecks(config: PrismConfig, files: string[]): DoctorCheck[] {
  const checks: DoctorCheck[] = [];
  const guard = config.guard;
  const secrets = guard.secrets ?? {};
  if (secrets.output_redaction_enabled !== true) {
    checks.push({ id: "redaction_off", level: "warn", message: "output redaction is off: tokens and passwords in command output reach the agent as written",
      fix: "set guard.secrets.output_redaction_enabled to true in ~/.parism/prism.config.json" });
  } else {
    checks.push({ id: "redaction_on", level: "ok", message: "output redaction is on (stdout, stderr, parsed results, kept results)" });
  }
  for (const file of files) {
    if (emptyOutputPatterns(file)) {
      checks.push({ id: "empty_output_patterns", level: "error", message: `${file} sets guard.secrets.output_patterns to []: redaction finds nothing even when it is on`,
        fix: "remove output_patterns to use the built-in patterns, or list the patterns you want" });
    }
  }
  if (guard.allowed_paths.length === 0) {
    checks.push({ id: "paths_unrestricted", level: "warn", message: "guard.allowed_paths is empty: commands can read any path", fix: "list the project directories in guard.allowed_paths" });
  } else if (guard.allowed_paths.some(p => path.resolve(p) === "/")) {
    checks.push({ id: "paths_root", level: "warn", message: "guard.allowed_paths contains /: commands can read any path", fix: "list the project directories instead of /" });
  }
  if (guard.allow_git_remote_write === true) {
    checks.push({ id: "git_remote_write", level: "info", message: "guard.allow_git_remote_write is on: git push and remote changes are allowed in build and ci profiles" });
  }
  const receipts = config.receipts ?? DEFAULT_RECEIPTS;
  if (receipts.enabled) {
    const key = signingKeyFor(config);
    checks.push(key.key
      ? { id: "receipts_signed", level: "ok", message: `receipts are on and signed (${key.file ?? receipts.key_file})` }
      : { id: "receipts_unsigned", level: "warn", message: `receipts are on but not signed: ${key.warning ?? "no key"}`, fix: "set receipts.key_file to a file outside guard.allowed_paths" });
  } else {
    checks.push({ id: "receipts_off", level: "info", message: "receipts are off: parism receipts check and the Stop hook have nothing to check", fix: "set receipts.enabled to true in the host config" });
  }
  return checks;
}

function installChecks(config: PrismConfig, cwd: string): DoctorCheck[] {
  const checks: DoctorCheck[] = [];
  const native = resolveNativeBinary();
  checks.push(native
    ? { id: "native_regex", level: "ok", message: `native regex engine: ${native}` }
    : { id: "native_regex", level: "warn", message: "native regex engine not found: patterns run on the JavaScript engine, which can backtrack on hostile patterns", fix: "reinstall @nerdvana/parism so the platform package is installed" });
  const missing = [...probeAll(config.guard.allowed_commands)].filter(([, r]) => r.status !== "installed").map(([c]) => c);
  checks.push(missing.length === 0
    ? { id: "commands", level: "ok", message: `all ${config.guard.allowed_commands.length} allowed commands are installed` }
    : { id: "commands", level: "info", message: `${missing.length} allowed command(s) are not installed: ${missing.join(", ")}` });
  const hooks = installedHooks(cwd, os.homedir());
  checks.push(hooks.length > 0
    ? { id: "hooks", level: "ok", message: hooks.map(h => `${h.client} ${h.scope} hooks: ${h.events.join(", ")} (${h.settings})`).join("; ") }
    : { id: "hooks", level: "info", message: "no parism hooks installed for this project", fix: "npx @nerdvana/parism hook install" });
  if (hooks.length > 0 && !existsSync(hookConfigFile())) {
    checks.push({ id: "hook_config", level: "warn", message: `hooks are installed but ${hookConfigFile()} is missing; hooks use the default config`, fix: "run parism hook install again" });
  }
  return checks;
}

/** 자주 거절되는 명령과 셸 문법. 설정을 바꿀 근거가 된다. */
async function rejectChecks(configPath: string | undefined): Promise<DoctorCheck[]> {
  const stats = await readStats({ since: "30d", ...(configPath && { config: configPath }) });
  const checks: DoctorCheck[] = [];
  for (const b of stats.top_blocked) {
    checks.push({ id: "frequent_block", level: "info", message: `'${b.cmd}' was blocked ${b.count} time(s) in the last 30 days`,
      fix: `if it is safe here, add it to guard.allowed_commands (or use profile "build") — describe("${b.cmd}") shows what is allowed` });
  }
  const ops = Object.entries(stats.shell_rejects.by_operator).sort((a, b) => b[1] - a[1]).slice(0, 5);
  for (const [op, count] of ops) checks.push({ id: "frequent_shell_reject", level: "info", message: `shell syntax ${JSON.stringify(op)} was refused ${count} time(s) in the last 30 days` });
  return checks;
}

export async function runDoctor(options: { config?: string; cwd?: string } = {}): Promise<DoctorReport> {
  const cwd    = options.cwd ?? process.cwd();
  const config = options.config ? await loadConfig(options.config) : await loadConfigMultiLayer();
  const files  = options.config ? [options.config] : [path.join(os.homedir(), ".parism", "prism.config.json"), path.join(cwd, "prism.config.json"), hookConfigFile()];
  const checks = [
    { id: "home", level: "info" as const, message: `Parism home: ${parismHome()}` },
    ...configChecks(config, files.filter(f => existsSync(f))),
    ...installChecks(config, cwd),
    ...await rejectChecks(options.config),
  ];
  return { checks, ok: !checks.some(c => c.level === "error") };
}

export function formatDoctor(report: DoctorReport): string {
  const mark: Record<CheckLevel, string> = { ok: "ok  ", warn: "WARN", error: "FAIL", info: "info" };
  const lines = report.checks.map(c => `${mark[c.level]} ${c.message}${c.fix ? `\n       fix: ${c.fix}` : ""}`);
  lines.push(report.ok ? "no blocking problems" : "one or more problems need fixing");
  return lines.join("\n");
}
