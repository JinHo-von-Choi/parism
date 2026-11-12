/**
 * `parism receipts` 명령. 영수증을 읽어 완료 조건을 판정하거나 목록을 보여 준다.
 * 명령을 실행하지 않는다. Stop 훅, CI, 리뷰 봇이 호출한다.
 *
 * 작성자: 최진호
 * 작성일: 2026-11-11
 */

import path from "node:path";
import { loadConfig, loadConfigMultiLayer, DEFAULT_RECEIPTS, type PrismConfig } from "../config/loader.js";
import { ReceiptStore, checkReceipts, loadSigningKey, verifyChain, type ChainReport, type CheckReport, type Receipt } from "../engine/receipts.js";
import { parismHome } from "./paths.js";

export interface ReceiptsCheckOptions {
  /** 판정할 작업 공간. 기본값은 현재 디렉터리다. */
  cwd?:     string;
  /** 판정할 명령. 주지 않으면 설정의 verify.commands를 쓴다. 각 항목은 [명령, 인자...]다. */
  require?: string[][];
  /** 설정 파일 경로. 주지 않으면 전역·프로젝트·환경 변수 설정을 읽는다. */
  config?:  string;
}

/**
 * `--require` 값 하나를 명령과 인자로 나눈다.
 * JSON 배열(`["npx","vitest","run"]`)이면 그대로 쓰고, 아니면 공백으로 나눈다.
 * 공백이 든 인자는 JSON 배열로 줘야 한다.
 */
export function parseRequire(value: string): string[] {
  const trimmed = value.trim();
  if (trimmed.startsWith("[")) {
    const parsed = JSON.parse(trimmed) as unknown;
    if (!Array.isArray(parsed) || parsed.length === 0 || !parsed.every(p => typeof p === "string" && p !== "")) {
      throw new Error(`--require ${value}: expected a non-empty JSON array of strings`);
    }
    return parsed as string[];
  }
  const parts = trimmed.split(/\s+/).filter(Boolean);
  if (parts.length === 0) throw new Error("--require needs a command");
  return parts;
}

/** key_file을 정하지 않았을 때 쓰는 서명 키 파일 */
export function autoKeyFile(): string {
  return path.join(parismHome(), "receipts", "receipts.key");
}

/** 설정에 맞는 서명 키. key_file이 없으면 Parism 홈의 자동 키다. */
export function signingKeyFor(config: PrismConfig): ReturnType<typeof loadSigningKey> {
  const receipts = config.receipts ?? DEFAULT_RECEIPTS;
  return loadSigningKey(receipts.key_file, config.guard.allowed_paths, autoKeyFile());
}

export function storeFor(config: PrismConfig): ReceiptStore {
  const receipts = config.receipts ?? DEFAULT_RECEIPTS;
  return new ReceiptStore(path.join(parismHome(), "receipts"), { maxEntries: receipts.max_entries, maxAgeDays: receipts.max_age_days });
}

async function configFor(configPath: string | undefined): Promise<PrismConfig> {
  return configPath ? loadConfig(configPath) : loadConfigMultiLayer();
}

/**
 * 완료 조건을 판정한다. 판정할 명령이 하나도 없으면 통과가 아니라 오류다.
 * 명령이 없다는 이유로 통과시키면 설정이 빠진 환경이 항상 통과한다.
 */
export async function receiptsCheck(options: ReceiptsCheckOptions = {}): Promise<CheckReport | { ok: false; error: string }> {
  const config   = await configFor(options.config);
  const commands = options.require && options.require.length > 0 ? options.require : config.verify?.commands ?? [];
  if (commands.length === 0) {
    return { ok: false, error: "no commands to check: give --require or set verify.commands in the host config" };
  }
  const receipts = config.receipts ?? DEFAULT_RECEIPTS;
  const signing  = signingKeyFor(config);
  if (receipts.key_file && !signing.key) {
    return { ok: false, error: signing.warning ?? "the signing key could not be loaded" };
  }
  const store  = storeFor(config);
  const report = await checkReceipts({
    receipts: store.list(),
    commands,
    cwd:      options.cwd ?? process.cwd(),
    limits:   { untrackedMaxFiles: receipts.untracked_max_files, untrackedMaxBytes: receipts.untracked_max_bytes },
    ...(signing.key && { key: signing.key }),
  });
  const chain = verifyChain(store.rawLines());
  return { ...report, ok: report.ok && chain.ok, chain };
}

/** 영수증 파일 전체의 체인과 서명을 검사한다. 명령을 실행하지 않는다. */
export async function receiptsVerify(options: { config?: string } = {}): Promise<ChainReport & { file: string; key_file?: string }> {
  const config  = await configFor(options.config);
  const signing = signingKeyFor(config);
  const store   = storeFor(config);
  return { ...verifyChain(store.rawLines(), signing.key), file: store.file, ...(signing.file && { key_file: signing.file }) };
}

/** 최근 영수증을 새것부터 돌려준다. */
export async function receiptsList(options: { limit?: number; config?: string } = {}): Promise<Receipt[]> {
  const all = storeFor(await configFor(options.config)).list();
  return all.slice(Math.max(0, all.length - (options.limit ?? 20))).reverse();
}

/** 판정 결과를 사람이 읽는 줄로 만든다. */
export function formatCheck(report: CheckReport): string {
  const lines = report.items.map(i => `${i.verdict === "ok" ? "ok  " : "FAIL"} ${i.command.join(" ")}  [${i.verdict}] ${i.detail}`);
  for (const p of report.chain?.problems ?? []) lines.push(`FAIL receipts.jsonl line ${p.line}  [${p.reason}] ${p.detail}`);
  const commandsOk = report.items.every(i => i.verdict === "ok");
  lines.push(commandsOk && report.ok ? "all required commands have a passing, fresh receipt"
    : commandsOk ? "the receipt file failed the chain check" : "one or more required commands lack a passing, fresh receipt");
  return lines.join("\n");
}

// ── export ────────────────────────────────────────────────────────────────

export type ExportFormat = "markdown" | "sarif" | "github" | "json";

export interface ExportSummary {
  generated_at:   string;
  cwd:            string;
  since?:         string;
  receipts:       number;
  commands:       { command: string; runs: number; last_exit: number; last_at: string; summary?: string; fresh: boolean }[];
  tests:          { passed: number; failed: number; skipped: number };
  diagnostics:    { errors: number; warnings: number };
  /** 명령별 마지막 실행 가운데 실패한 것. 뒤에 다시 돌려 통과한 실패는 들지 않는다. */
  failed_runs:    { command: string; at: string; detail: string; id: string }[];
  /** 기간 안의 모든 실패한 실행 수(나중에 통과한 것 포함) */
  failed_runs_total: number;
  workspace?:     { git_head: string; state_digest: string };
  /** 가장 최근 영수증의 작업 공간 상태가 지금과 같은지 */
  fresh:          boolean;
  chain:          ChainReport;
  guard_blocks:   number;
  blocked_commands: { cmd: string; count: number }[];
  saved_tokens:   number;
}

/** 영수증과 사용 통계를 PR·CI에 붙일 요약으로 모은다. 명령을 실행하지 않는다. */
export async function receiptsExport(options: { cwd?: string; config?: string; since?: string } = {}): Promise<ExportSummary> {
  const { workspaceState: stateOf }        = await import("../engine/receipts.js");
  const { readStats, parseSince }          = await import("./stats.js");
  const config   = await configFor(options.config);
  const limits   = config.receipts ?? DEFAULT_RECEIPTS;
  const cwd      = options.cwd ?? process.cwd();
  const since    = parseSince(options.since);
  const current  = await stateOf(cwd, { untrackedMaxFiles: limits.untracked_max_files, untrackedMaxBytes: limits.untracked_max_bytes });
  const store    = storeFor(config);
  const all      = store.list().filter(r => (current ? r.workspace?.root === current.root : r.cwd === cwd) && (since === undefined || Date.parse(r.started_at) >= since));
  const signing  = signingKeyFor(config);
  const byCommand = new Map<string, Receipt[]>();
  for (const r of all) {
    const key = [r.cmd, ...(r.args_requested ?? r.args)].join(" ");
    byCommand.set(key, [...(byCommand.get(key) ?? []), r]);
  }
  const tests = { passed: 0, failed: 0, skipped: 0 };
  const diagnostics = { errors: 0, warnings: 0 };
  const commands = [...byCommand].map(([command, list]) => {
    const last = list.at(-1)!;
    const s    = last.summary;
    if (s?.kind === "test") { tests.passed += s.passed; tests.failed += s.failed; tests.skipped += s.skipped; }
    if (s?.kind === "diagnostics") { diagnostics.errors += s.errors; diagnostics.warnings += s.warnings; }
    return {
      command, runs: list.length, last_exit: last.exit_code, last_at: last.started_at,
      ...(s && { summary: s.kind === "test" ? `${s.passed} passed, ${s.failed} failed, ${s.skipped} skipped` : `${s.errors} errors, ${s.warnings} warnings` }),
      fresh: current !== undefined && last.workspace?.state_digest === current.state_digest,
    };
  });
  const isFailure = (r: Receipt) => r.exit_code !== 0 || r.failure_reason !== undefined;
  const latestPerCommand = [...byCommand.values()].map(list => list.at(-1)!);
  const failed = latestPerCommand.filter(isFailure).map(r => ({
    command: [r.cmd, ...(r.args_requested ?? r.args)].join(" "), at: r.started_at, id: r.id,
    detail: r.failure_reason ?? `exit code ${r.exit_code}${r.summary?.kind === "test" ? `, ${r.summary.failed} failed test(s)` : ""}`,
  }));
  const stats  = await readStats({ ...(options.since && { since: options.since }), ...(options.config && { config: options.config }) });
  const latest = all.at(-1);
  return {
    generated_at: new Date().toISOString(), cwd, ...(since !== undefined && { since: new Date(since).toISOString() }),
    receipts: all.length, commands, tests, diagnostics, failed_runs: failed, failed_runs_total: all.filter(isFailure).length,
    ...(current && { workspace: { git_head: current.git_head, state_digest: current.state_digest } }),
    fresh: current !== undefined && latest?.workspace?.state_digest === current.state_digest,
    chain: verifyChain(store.rawLines(), signing.key),
    guard_blocks: stats.guard_blocks.total + stats.hook.blocked, blocked_commands: stats.top_blocked, saved_tokens: stats.saved_tokens,
  };
}

function mdEscape(text: string): string {
  return text.replace(/\|/g, "\\|").replace(/\n/g, " ");
}

export function formatExportMarkdown(s: ExportSummary): string {
  const ok = (b: boolean) => (b ? "yes" : "no");
  const lines = [
    "## Parism verification report",
    "",
    "| item | value |",
    "|-|-|",
    `| receipts | ${s.receipts} |`,
    `| tests | ${s.tests.passed} passed, ${s.tests.failed} failed, ${s.tests.skipped} skipped |`,
    `| diagnostics | ${s.diagnostics.errors} errors, ${s.diagnostics.warnings} warnings |`,
    `| commands whose last run failed | ${s.failed_runs.length} (failed runs in the period: ${s.failed_runs_total}) |`,
    `| guard blocks | ${s.guard_blocks} |`,
    `| tokens saved | ${s.saved_tokens.toLocaleString("en-US")} |`,
    `| git HEAD | ${s.workspace?.git_head ?? "(not a git repository)"} |`,
    `| latest receipt matches the current workspace | ${ok(s.fresh)} |`,
    `| receipt chain and signatures intact | ${ok(s.chain.ok)}${s.chain.signed ? "" : " (unsigned)"} |`,
    "",
  ];
  if (s.commands.length > 0) {
    lines.push("| command | runs | last exit | result | matches workspace |", "|-|-|-|-|-|");
    for (const c of s.commands) lines.push(`| \`${mdEscape(c.command)}\` | ${c.runs} | ${c.last_exit} | ${mdEscape(c.summary ?? "")} | ${ok(c.fresh)} |`);
    lines.push("");
  }
  if (s.failed_runs.length > 0) {
    lines.push("Commands whose last run failed:", "");
    for (const f of s.failed_runs.slice(-20)) lines.push(`- \`${mdEscape(f.command)}\` at ${f.at}: ${mdEscape(f.detail)}`);
    lines.push("");
  }
  if (s.chain.problems.length > 0) {
    lines.push("Receipt file problems:", "");
    for (const p of s.chain.problems.slice(0, 20)) lines.push(`- line ${p.line}: ${p.reason} (${mdEscape(p.detail)})`);
    lines.push("");
  }
  return lines.join("\n");
}

/** SARIF 2.1.0. 실패한 실행, 체인 문제, 지금 상태와 맞지 않는 마지막 영수증을 결과로 낸다. */
export function formatExportSarif(s: ExportSummary, version: string): string {
  const results = [
    ...s.failed_runs.map(f => ({
      ruleId: "parism/failed-run", level: "error",
      message: { text: `${f.command} failed at ${f.at}: ${f.detail} (receipt ${f.id})` },
    })),
    ...s.chain.problems.map(p => ({
      ruleId: "parism/receipt-integrity", level: "error",
      message: { text: `receipts.jsonl line ${p.line}: ${p.reason}. ${p.detail}` },
    })),
    ...(s.receipts > 0 && !s.fresh ? [{
      ruleId: "parism/stale-receipt", level: "warning",
      message: { text: "the latest receipt was taken before the current workspace state; the checks were not run on these changes" },
    }] : []),
  ];
  return JSON.stringify({
    $schema: "https://json.schemastore.org/sarif-2.1.0.json",
    version: "2.1.0",
    runs: [{
      tool: { driver: {
        name: "parism", version, informationUri: "https://github.com/JinHo-von-Choi/parism",
        rules: [
          { id: "parism/failed-run", shortDescription: { text: "A test, build or lint run ended with a failure" } },
          { id: "parism/receipt-integrity", shortDescription: { text: "The receipt file was edited, reordered or has a wrong signature" } },
          { id: "parism/stale-receipt", shortDescription: { text: "The latest receipt does not match the current workspace" } },
        ],
      } },
      results,
    }],
  }, null, 2);
}
