/**
 * run 한 번의 파이프라인.
 *
 * 다섯 단계로 나눈다. 각 단계는 앞 단계가 채운 RunState를 읽고 자기 몫을 채운다.
 *
 *   stagePrepareCommand   명령 문자열 해석(렉서, 글로브, 파이프 단계), 계약·예산·투영 인자 검사
 *   stageGuardAndExec     가드 검사, 실행, 러너 보고서 읽기
 *   stageParseAndProject  파싱, 실패 귀속, parsed 리댁션, 파이프 단계, 투영, 자동 보관 미리보기, 표현 형식
 *   stageRedactAndReview  원문 마스킹, 재검토와 보관, 출처 분류
 *   stageReceiptAndBudget 영수증, git 변경 요약(_delta), 텔레메트리, 예산, 사용 통계
 *
 * 단계 사이의 의존은 RunState 하나뿐이다. ParismEngine은 이 모듈을 부르기만 한다.
 *
 * 작성자: 최진호
 * 작성일: 2026-11-12
 */

import { closeSync, fstatSync, mkdtempSync, openSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir }                                                   from "node:os";
import path                                                         from "node:path";
import type { PrismConfig }                                         from "../config/loader.js";
import { DEFAULT_OUTPUT, DEFAULT_RECEIPTS }                         from "../config/loader.js";
import type { OutputFormat, ParserRegistry }                        from "../parsers/registry.js";
import type { FailureInfo, ParseErrorField, ResponseEnvelope }      from "../types/envelope.js";
import { execute, truncateUtf8Lines, type ExecControl }             from "../engine/executor.js";
import { ReceiptStore, newReceiptId, sha256, signReceipt, summarize, workspaceState, type Receipt } from "../engine/receipts.js";
import { devloopRowsKey, machineFormatArgs, relativizeReport, type MachineArgs } from "../parsers/devloop/index.js";
import { deriveOrigin, externalFields, fixedFields, fixedViolations, originTableFor, tableForResult, type OriginTable } from "../parsers/origin.js";
import { checkGuard, GuardError }                                   from "../engine/guard.js";
import { buildAvailabilityFailure }                                 from "../engine/availability.js";
import { buildExecArgs }                                            from "../engine/policy.js";
import type { Semaphore }                                           from "../engine/semaphore.js";
import { redact, redactParsedValue, validatePatterns }              from "../engine/redactor.js";
import type { RegexFallback }                                       from "../engine/regex-engine.js";
import { toCompact }                                                from "../parsers/compact.js";
import { PipelineTimer, type OutcomeStats }                         from "../engine/telemetry.js";
import { applyProjection, hasProjection, parseProjection, type ProjectionSummary } from "../engine/projection.js";
import { budgetTooSmall, validateTokenizer, MINIMUM_ENVELOPE_TOKENS } from "../engine/budget/index.js";
import { countTokens }                                              from "../engine/budget/tokenizer.js";
import type { ResultStore }                                         from "../engine/result-store.js";
import type { RawEvidence }                                         from "../engine/evidence.js";
import { mintResultId }                                             from "../engine/review.js";
import { maskWithRanges, type MaskedRange }                         from "../engine/mask-map.js";
import { expandGlobs, lexCommand, quoteArg, SAFE_ENV_NAMES, type StderrMode } from "../engine/command-lexer.js";
import { applyStages, applyTextFilters, parsePipeline, toProjectionStages, type FilterSpec, type ProjectionStage } from "../engine/pipe-compiler.js";
import { attributeReport }                                          from "../engine/attribution.js";
import { gitDelta, isMutatingGit }                                  from "../engine/git-delta.js";
import type { StatsLog }                                            from "../engine/stats-log.js";
import {
  buildGuardErrorEnvelope, buildRejectedEnvelope, projectionInput, resolveRedactPatterns, type RunOptions,
} from "./envelope.js";
import { attachReview }                                             from "./review.js";
import { applyRunBudget, type PageStore }                           from "./run-budget.js";

/** 파이프라인이 쓰는 엔진 상태. ParismEngine이 가진 것을 그대로 넘긴다. */
export interface RunDeps {
  config:      PrismConfig;
  registry:    ParserRegistry;
  execSlots:   Semaphore;
  stats:       OutcomeStats | null;
  results:     ResultStore;
  pages:       PageStore;
  receipts:    ReceiptStore | null;
  receiptKey?: Buffer;
  statsLog:    StatsLog | null;
}

/** 태스크로 실행할 때만 쓰는 실행 제어. 태스크는 일반 실행 슬롯을 쓰지 않고 태스크용 시간 제한을 받는다. */
export interface RunControl {
  timeoutMs: number;
  exec:      ExecControl;
}

/** 파이프 단계 처리 정보. 응답의 _compiled_pipeline에 실린다. */
interface PipelinePlan {
  original: string;
  specs:    FilterSpec[];
  stages:   string[][];
  stderr?:  StderrMode;
  notes:    string[];
}

/** 파이프라인이 단계마다 채우는 상태 */
interface RunState {
  cmd:           string;
  args:          string[];
  requestedArgs: string[];
  cwd:           string;
  /** 명령 앞 대입으로 넘길 환경 변수 */
  env?:          Record<string, string>;
  opts:          RunOptions;
  format:        OutputFormat;
  includeDiff:   boolean;
  wantReview:    boolean;
  wantRetain:    boolean;
  wantEvidence:  boolean;
  machine:       MachineArgs | null;
  projection?:   ReturnType<typeof parseProjection>;
  devloopRows?:  "failures" | "diagnostics";
  parseWhole:    boolean;
  pipeline?:     PipelinePlan;
  notes:         string[];
  timer:         PipelineTimer | null;
  maskingOn:     boolean;
  patterns:      string[];
  fallbacks:     RegexFallback[];
  startedAt:     number;
  /** 아래는 stageGuardAndExec가 채운다 */
  executed?:     ResponseEnvelope;
  envelope?:     ResponseEnvelope;
  reportText?:   string;
  parseInput?:   string;
}

/** stageParseAndProject의 결과 */
interface ParsedOutcome {
  parsed:        unknown;
  parseError?:   ParseErrorField;
  native:        boolean;
  originTable?:  OriginTable;
  rawEvidence:   RawEvidence;
  evidenceReason?: string;
  maxItems:      number;
  final:         unknown;
  compactApplied: boolean;
  rawOmitted:    boolean;
  representationFailure?: FailureInfo;
  enriched:      ResponseEnvelope;
  redactions:    number;
  /**
   * 자동 보관 미리보기를 만들었을 때만 있다. source는 투영 전 전체 결과, stored는 보관본의 본문(미리보기와 표현 변환 전)이다.
   * 보관본 본문이 전체 행이어야 explain_result와 query_result의 행 포인터가 미리보기 밖의 행도 가리킨다.
   */
  autoRetain?:   { total: number; shown: number; source: unknown; stored: unknown; complete: boolean; rawEvidence?: RawEvidence };
  pipeMode?:     "rows" | "text";
  pipeStages?:   ProjectionStage[];
}

/** run 한 번을 끝까지 실행한다 */
export async function runPipeline(deps: RunDeps, cmd: string, opts: RunOptions = {}, control?: RunControl): Promise<ResponseEnvelope> {
  const prepared = stagePrepareCommand(deps, cmd, opts);
  if ("rejected" in prepared) return prepared.rejected;
  const state = prepared.state;
  const rejected = await stageGuardAndExec(deps, state, control);
  if (rejected) return rejected;
  const outcome = await stageParseAndProject(deps, state);
  const reviewed = await stageRedactAndReview(deps, state, outcome);
  return stageReceiptAndBudget(deps, state, outcome, reviewed);
}

// ── 1. 준비 ────────────────────────────────────────────────────────────────

/**
 * cmd에 명령줄 전체가 들어왔는지. args 없이 공백이나 셸 연산자, 따옴표가 있으면 명령 문자열로 본다.
 * 경로로 쓴 실행 파일(./build/app)은 공백이 없으므로 그대로 명령 이름이다.
 */
export function looksLikeCommandLine(cmd: string, args: readonly string[] | undefined): boolean {
  return (args === undefined || args.length === 0) && /[\s|&;<>'"`$*?]/.test(cmd.trim());
}

/** 명령 문자열을 해석한 결과 */
export type ResolvedCommand =
  | { ok: true; cmd: string; args: string[]; cwd: string; pipeline?: PipelinePlan; notes: string[]; env?: Record<string, string> }
  | { ok: false; failure: FailureInfo };

/**
 * command 문자열(또는 명령줄 전체가 든 cmd)을 cmd, args, cwd, 파이프 단계로 바꾼다.
 * 명령 문자열이 아니면 받은 값을 그대로 돌려준다. dry_run, run_paged도 같은 해석을 쓴다.
 */
export function resolveCommand(cmd: string, opts: { command?: string; args?: string[]; cwd?: string }): ResolvedCommand {
  const resolved = resolveCommandLine(cmd, opts);
  if (!resolved.ok) return resolved;
  const folded = foldEnvCommand(resolved);
  return folded.ok ? foldGitDirectory(folded) : folded;
}

/**
 * `env NAME=값 명령 ...`을 명령 앞 대입과 같게 다룬다. 이름은 SAFE_ENV_NAMES 안의 것만 받는다.
 * 대입 뒤에 명령이 없거나(`env A=1`) env의 옵션(`env -i`)을 쓰면 env 명령으로 그대로 둔다.
 */
function foldEnvCommand(resolved: Extract<ResolvedCommand, { ok: true }>): ResolvedCommand {
  if (resolved.cmd !== "env") return resolved;
  const assignment = /^[A-Za-z_][A-Za-z0-9_]*=/;
  let i = 0;
  while (i < resolved.args.length && assignment.test(resolved.args[i]!)) i++;
  if (i === 0 || i >= resolved.args.length || resolved.args[i]!.startsWith("-")) return resolved;
  const env: Record<string, string> = { ...(resolved.env ?? {}) };
  for (const word of resolved.args.slice(0, i)) {
    const eq   = word.indexOf("=");
    const name = word.slice(0, eq);
    if (!SAFE_ENV_NAMES.has(name)) {
      return { ok: false, failure: {
        kind: "config", reason: "unsupported_shell_operator", operator: "=",
        message: `command was not run: environment variable '${name}' is not applied`,
        suggestion: `only these variables can be set before a command: ${[...SAFE_ENV_NAMES].join(", ")}`,
      } };
    }
    env[name] = word.slice(eq + 1);
  }
  return {
    ...resolved, cmd: resolved.args[i]!, args: resolved.args.slice(i + 1), env,
    notes: [...resolved.notes, `environment set for the command: ${Object.keys(env).join(", ")}`],
  };
}

/**
 * `git -C <dir> ...`의 앞쪽 `-C`를 작업 디렉터리로 옮긴다. `cd <dir> && git ...`과 같은 실행이고,
 * 옮긴 디렉터리도 다른 작업 디렉터리처럼 guard의 allowed_paths 검사를 받는다. `-C`가 여러 번이면 git처럼 차례로 이어 붙인다.
 * `--git-dir=<dir>`도 같이 옮긴다. `<dir>`이 `.git`이면 그 상위 디렉터리, 아니면 bare 저장소로 보고 `<dir>` 자체에서 실행한다.
 */
function foldGitDirectory(resolved: Extract<ResolvedCommand, { ok: true }>): ResolvedCommand {
  if (resolved.cmd !== "git") return resolved;
  const args = [...resolved.args];
  let cwd    = resolved.cwd;
  let moved  = false;
  for (let i = 0; i < args.length;) {
    const arg = args[i]!;
    if (arg === "--no-pager") { i++; continue; }
    if (arg === "-C" && i + 1 < args.length) {
      cwd = path.resolve(cwd, args[i + 1]!);
      args.splice(i, 2);
      moved = true;
      continue;
    }
    const gitDir = arg.startsWith("--git-dir=") ? arg.slice("--git-dir=".length) : arg === "--git-dir" ? args[i + 1] : undefined;
    if (gitDir !== undefined && gitDir !== "") {
      const dir = path.resolve(cwd, gitDir);
      cwd = path.basename(dir) === ".git" ? path.dirname(dir) : dir;
      args.splice(i, arg === "--git-dir" ? 2 : 1);
      moved = true;
      continue;
    }
    break;
  }
  if (!moved) return resolved;
  return { ...resolved, args, cwd, notes: [...resolved.notes, `git ran in ${cwd}`] };
}

function resolveCommandLine(cmd: string, opts: { command?: string; args?: string[]; cwd?: string }): ResolvedCommand {
  const baseCwd = opts.cwd ?? process.cwd();
  const text    = opts.command ?? (looksLikeCommandLine(cmd, opts.args) ? cmd : undefined);
  if (text === undefined) return { ok: true, cmd, args: opts.args ?? [], cwd: baseCwd, notes: [] };
  if (opts.command !== undefined && (opts.args?.length ?? 0) > 0) {
    return { ok: false, failure: { kind: "config", reason: "command_and_args", message: "give either command (one string) or cmd with args, not both" } };
  }
  const lexed = lexCommand(text);
  if (!lexed.ok) {
    return { ok: false, failure: {
      kind: "config", reason: lexed.reason,
      message: `command was not run: ${lexed.message}${lexed.operator !== undefined && !lexed.message.includes(lexed.operator) ? ` (${JSON.stringify(lexed.operator)})` : ""}`,
      suggestion: lexed.hint,
      ...(lexed.operator !== undefined && { operator: lexed.operator }),
    } };
  }
  const cwd      = lexed.cwd === undefined ? baseCwd : path.resolve(baseCwd, lexed.cwd);
  const expanded = expandGlobs(lexed, cwd);
  let pipeline: PipelinePlan | undefined;
  if (expanded.pipeline.length > 0 || expanded.stderr) {
    const specs = parsePipeline(expanded.pipeline);
    if (!specs.ok) {
      return { ok: false, failure: { kind: "config", reason: "unsupported_pipe_stage", message: `command was not run: ${specs.message} (stage: ${specs.stage})`, suggestion: specs.hint } };
    }
    pipeline = {
      original: text, specs: specs.specs, stages: expanded.pipeline,
      ...(expanded.stderr && { stderr: expanded.stderr }), notes: [],
    };
  }
  return { ok: true, cmd: expanded.cmd, args: expanded.args, cwd, ...(pipeline && { pipeline }), notes: expanded.notes, ...(expanded.env && { env: expanded.env }) };
}

/** 실행 전에 거절할 계약·예산 오류. 없으면 undefined다. */
function preflightFailure(opts: RunOptions, wantReview: boolean): FailureInfo | undefined {
  if ((opts.machine_format === true || opts.aggregate !== undefined) && !wantReview) {
    return { kind: "config", reason: "requires_contract_next", message: "machine_format and aggregate need contract_version: \"next\"; the command was not run" };
  }
  /** 예산은 실행 전에 검사한다. 최소 봉투조차 담지 못하는 예산을 실행 뒤에 알리면 명령만 실행되고 값을 못 받는다. */
  if (!opts.budget) return undefined;
  const tokenizer = validateTokenizer(opts.budget.tokenizer);
  if (!tokenizer.ok) return { kind: "config", reason: "tokenizer_unsupported", message: tokenizer.message };
  if (budgetTooSmall(opts.budget, tokenizer.id)) {
    return {
      kind: "config", reason: "budget_too_small",
      message: `max_tokens ${opts.budget.max_tokens} cannot hold the minimal envelope (about ${MINIMUM_ENVELOPE_TOKENS} tokens); the command was not run`,
    };
  }
  return undefined;
}

function stagePrepareCommand(deps: RunDeps, cmdIn: string, opts: RunOptions): { state: RunState } | { rejected: ResponseEnvelope } {
  const resolved = resolveCommand(cmdIn, opts);
  if (!resolved.ok) {
    const first = (opts.command ?? cmdIn).trim().split(/\s+/)[0] ?? "";
    deps.statsLog?.record({ kind: "shell_reject", cmd: first, outcome: resolved.failure.operator ?? resolved.failure.reason });
    return { rejected: buildRejectedEnvelope(first, opts.args ?? [], opts.cwd ?? process.cwd(), resolved.failure) };
  }
  const { cmd, cwd } = resolved;
  const wantReview   = opts.contract_version === "next";
  /**
   * machine_format이면 러너의 기계용 출력 형식 인자를 실행 전에 덧붙인다.
   * 바꿀 수 없는 실행(러너가 아님, 다른 형식을 이미 지정함)은 인자를 그대로 둔다. 덧붙인 인자도 가드 검사를 받는다.
   */
  const machine = opts.machine_format === true ? machineFormatArgs(cmd, resolved.args) : null;
  const args    = machine?.args ?? resolved.args;
  const refused = preflightFailure(opts, wantReview);
  if (refused) return { rejected: buildRejectedEnvelope(cmd, refused.reason === "requires_contract_next" ? resolved.args : args, cwd, refused) };
  return { state: initialState(deps, opts, resolved, machine, args, wantReview) };
}

/** 준비 단계가 채우는 상태 */
function initialState(
  deps: RunDeps, opts: RunOptions, resolved: Extract<ResolvedCommand, { ok: true }>, machine: MachineArgs | null, args: string[], wantReview: boolean,
): RunState {
  /** 투영 인자의 형식 오류는 가드 검사 뒤에 알린다(stageGuardAndExec). 허용되지 않은 명령에는 인자 검사 결과를 보이지 않는다. */
  const requested   = projectionInput(opts);
  const projection  = hasProjection(requested) ? parseProjection(requested) : undefined;
  const devloopRows = devloopRowsKey(resolved.cmd, args);
  const maskingOn   = deps.config.guard.secrets?.output_redaction_enabled === true;
  return {
    cmd: resolved.cmd, args, requestedArgs: resolved.args, cwd: resolved.cwd, opts,
    ...(resolved.env && { env: resolved.env }),
    format:       (opts.format ?? "json") as OutputFormat,
    includeDiff:  opts.includeDiff ?? false,
    wantReview,
    wantRetain:   opts.retain === true && wantReview,
    wantEvidence: wantReview && (opts.evidence ?? "none") !== "none",
    machine,
    ...(projection && { projection }),
    ...(devloopRows && { devloopRows }),
    /**
     * 시험 러너와 진단 도구의 출력은 JSON 문서 하나라서 중간에서 자르면 읽을 수 없다.
     * 이 명령들은 수집 상한 없이 받아 파싱하고, 파싱에 실패했을 때만 원문을 max_output_bytes로 잘라 싣는다.
     */
    parseWhole:   devloopRows !== undefined,
    ...(resolved.pipeline && { pipeline: resolved.pipeline }),
    notes:        resolved.notes,
    timer:        deps.config.telemetry?.enabled === true ? new PipelineTimer() : null,
    maskingOn,
    patterns:     maskingOn ? validatePatterns(resolveRedactPatterns(deps.config)) : [],
    fallbacks:    [],
    startedAt:    Date.now(),
  };
}

// ── 2. 가드와 실행 ──────────────────────────────────────────────────────────

/**
 * 실행 실패가 "이 호스트에 명령이 없다"(ENOENT)일 때 설치 정보를 덧붙인다.
 * 대체 명령도 원래 명령과 같은 가드를 통과해야 안내한다.
 */
export function attachAvailability(config: PrismConfig, envelope: ResponseEnvelope, cmd: string, args: readonly string[], cwd: string): ResponseEnvelope {
  if (envelope.failure?.reason !== "spawn_failed") return envelope;
  if (envelope.failure.errorCode !== "ENOENT") return envelope;
  const permits = (altCmd: string, altArgs: readonly string[]): boolean => {
    try {
      checkGuard(altCmd, [...altArgs], cwd, config);
      return true;
    } catch {
      return false;
    }
  };
  const availability = buildAvailabilityFailure(cmd, args, permits);
  if (!availability) return envelope;
  return { ...envelope, failure: { ...envelope.failure, availability } };
}

async function stageGuardAndExec(deps: RunDeps, state: RunState, control: RunControl | undefined): Promise<ResponseEnvelope | undefined> {
  const { cmd, args, cwd } = state;
  const config = deps.config;
  state.timer?.markStart("guard");
  try {
    checkGuard(cmd, args, cwd, config);
  } catch (err) {
    if (err instanceof GuardError) {
      deps.stats?.record(cmd, "guard", err.reason);
      deps.statsLog?.record({ kind: "guard_block", cmd, outcome: err.reason });
      return buildGuardErrorEnvelope(cmd, args, cwd, err);
    }
    throw err;
  }
  state.timer?.markEnd("guard");
  if (state.projection && !state.projection.ok) {
    return buildRejectedEnvelope(cmd, args, cwd, { kind: "config", reason: state.projection.reason, message: state.projection.message });
  }

  /**
   * 보고서를 파일로만 쓰는 러너는 Parism이 만든 임시 디렉터리의 파일로 받는다.
   * 이 경로 인자는 가드 검사 뒤에 붙인다. 호출자가 정한 값이 아니라 Parism이 정한 고정 형식의 경로다.
   */
  const reportDir  = state.machine?.reportFlag ? mkdtempSync(path.join(tmpdir(), "parism-report-")) : undefined;
  const reportFile = reportDir ? path.join(reportDir, "report") : undefined;
  const reportArgs = reportFile && state.machine?.reportFlag ? state.machine.reportFlag(reportFile) : [];

  state.timer?.markStart("exec");
  const launch = (): Promise<ResponseEnvelope> => execute(
    cmd, [...buildExecArgs(cmd, args, config.guard), ...reportArgs], cwd,
    config.guard.secrets?.env_patterns ?? [],
    control?.timeoutMs ?? config.guard.timeout_ms,
    /** 파이프 뒤 단계는 전체 출력을 봐야 셸과 같은 결과가 된다. 수집 상한은 실행기의 버퍼 상한만 쓴다. */
    state.parseWhole || state.pipeline ? 0 : config.guard.max_output_bytes,
    state.includeDiff,
    state.env ? { ...(control?.exec ?? {}), env: state.env } : control?.exec,
  );
  try {
    state.executed   = control ? await launch() : await deps.execSlots.run(launch);
    state.reportText = reportFile ? readReport(reportFile) : undefined;
  } finally {
    if (reportDir) rmSync(reportDir, { recursive: true, force: true });
  }
  let envelope = attachAvailability(config, { ...state.executed, args }, cmd, args, cwd);
  if (state.pipeline?.stderr === "discard") envelope = { ...envelope, stderr: { ...envelope.stderr, raw: "" } };
  state.envelope   = envelope;
  /** 파서가 읽을 출력. 보고서 파일을 받았으면 그 내용이고, 아니면 표준 출력이다. */
  state.parseInput = state.reportText ?? envelope.stdout.raw;
  state.timer?.markEnd("exec");
  state.timer?.setRawBytes(Buffer.byteLength(envelope.stdout.raw, "utf8"));
  return undefined;
}

// ── 3. 파싱과 투영 ──────────────────────────────────────────────────────────

/** 파서를 돌린다. 투영이나 자동 보관이 쓸 계약(행 배열 키, 필드)도 함께 얻는다. */
function parseOutput(deps: RunDeps, state: RunState, maxItems: number): {
  parsed: unknown; parseError?: ParseErrorField; native: boolean; rawEvidence: RawEvidence; evidenceReason?: string;
  shape?: { rowsKey?: string; rowFields?: readonly string[] };
} {
  const parseFormat   = state.format === "json-no-raw" ? "json" : state.format;
  const strictSchemas = deps.config.parsers?.strict_schemas ?? false;
  const input         = state.parseInput!;
  return deps.registry.withCallDeadline(state.cmd, () => {
    const result = state.wantEvidence
      ? deps.registry.parseWithFallbackWithEvidence(state.cmd, state.args, input, { maxItems, format: parseFormat }, strictSchemas)
      : deps.registry.parseWithFallback(state.cmd, state.args, input, { maxItems, format: parseFormat }, strictSchemas);
    const withEvidence = result as { evidence?: RawEvidence; evidenceReason?: string };
    const native       = "native" in result ? result.native === true : false;
    const contract     = result.parsed != null && !native ? deps.registry.contractFor(state.cmd, state.args) : undefined;
    const shape        = contract && state.devloopRows ? { ...contract, rowsKey: state.devloopRows } : contract;
    return {
      parsed: result.parsed, ...(result.parse_error && { parseError: result.parse_error }), native,
      rawEvidence: state.wantEvidence ? withEvidence.evidence ?? {} : {},
      ...(state.wantEvidence && withEvidence.evidenceReason && { evidenceReason: withEvidence.evidenceReason }),
      ...(shape && { shape }),
    };
  });
}

/** 결과의 행 배열과 그 키. 계약의 행 배열 키가 있으면 그것, 없으면 유일한 배열이다. 여럿이면 undefined다. */
export function rowArrayOf(value: unknown, rowsKey: string | undefined): { key: string | null; rows: unknown[] } | undefined {
  if (Array.isArray(value)) return { key: null, rows: value };
  if (value === null || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  if (rowsKey !== undefined && Array.isArray(record[rowsKey])) return { key: rowsKey, rows: record[rowsKey] as unknown[] };
  const arrays = Object.keys(record).filter(k => Array.isArray(record[k]) && k !== "_summary");
  return arrays.length === 1 ? { key: arrays[0]!, rows: record[arrays[0]!] as unknown[] } : undefined;
}

/** 행 배열을 바꾼 결과. 결과가 최상위 배열이면 배열 그대로, 객체면 같은 키에 넣고 _summary를 둔다. */
function withRows(value: unknown, key: string | null, rows: unknown[], summary: Record<string, unknown>): unknown {
  if (key === null) return rows;
  return { ...(value as Record<string, unknown>), [key]: rows, _summary: summary };
}

/** 파이프 뒤 단계를 적용한다. 행 모드가 되면 parsed를 바꾸고, 글자 모드면 stdout.raw를 바꾸고 parsed를 비운다. */
async function applyPipeline(
  state: RunState, parsed: unknown, shape: { rowsKey?: string; rowFields?: readonly string[] } | undefined,
): Promise<{ parsed: unknown; raw?: string; mode: "rows" | "text"; stages?: ProjectionStage[]; total?: number }> {
  const plan   = state.pipeline!;
  /**
   * 시험 러너·린터의 출력은 이미 보고서 하나로 읽었다. `| tail -n 50`, `| head` 같은 자르기는 보고서 원문(기계용 형식)을
   * 자르는 것이 아니라 전체 보고서를 보려는 것이므로 적용하지 않는다. 그 밖의 단계는 실패·진단 행에 적용한다.
   */
  if (state.parseWhole && parsed != null) {
    if (plan.specs.every(spec => spec.kind === "head" || spec.kind === "tail")) {
      plan.notes.push("head/tail after a test runner or linter were not applied: the parsed report already lists every failure");
      return { parsed, mode: "rows", stages: [] };
    }
  }
  const mergeBlocksRows = plan.stderr === "merge" && !state.parseWhole;
  const target = parsed != null && !mergeBlocksRows ? rowArrayOf(parsed, shape?.rowsKey ?? state.devloopRows) : undefined;
  if (target && plan.specs.length > 0) {
    const fields = new Set<string>(shape?.rowFields ?? []);
    for (const row of target.rows) if (row && typeof row === "object") for (const k of Object.keys(row)) fields.add(k);
    const stages = toProjectionStages(plan.specs, fields);
    if (stages) {
      const out = await applyStages(target.rows, stages, { onFallback: info => state.fallbacks.push(info) });
      if (out.count !== undefined) return { parsed: { count: out.count, _summary: { total: out.total, matched: out.count } }, mode: "rows", stages, total: out.total };
      return { parsed: withRows(parsed, target.key, out.rows, { total: out.total, matched: out.matched, shown: out.rows.length }), mode: "rows", stages, total: out.total };
    }
  }
  const envelope = state.envelope!;
  const input    = plan.stderr === "merge" ? envelope.stdout.raw + envelope.stderr.raw : envelope.stdout.raw;
  const raw      = await applyTextFilters(input, plan.specs, { onFallback: info => state.fallbacks.push(info) });
  return { parsed: null, raw, mode: "text" };
}

/**
 * 자동 보관 미리보기. 행이 auto_retain_rows를 넘고 limit와 budget이 없으면 앞의 preview_rows행만 남긴다.
 * 보관할 전체 결과가 파서 상한(max_items)에서 잘렸을 수 있으면 상한 없이 다시 파싱한다.
 */
async function previewFor(
  deps: RunDeps, state: RunState, final: unknown, parsed: unknown, maxItems: number,
  shape: { rowsKey?: string } | undefined,
): Promise<{ final: unknown; autoRetain?: ParsedOutcome["autoRetain"] }> {
  const output = deps.config.output ?? DEFAULT_OUTPUT;
  if (output.auto_retain_rows <= 0 || state.opts.budget || state.opts.limit !== undefined || state.opts.aggregate !== undefined) return { final };
  const target = rowArrayOf(final, shape?.rowsKey);
  if (!target || target.rows.length <= output.auto_retain_rows) return { final };

  let source   = parsed;
  let complete = maxItems === 0;
  let rawEvidence: RawEvidence | undefined;
  if (!complete && !state.projection && !state.pipeline && !state.parseWhole && target.rows.length >= maxItems) {
    /**
     * 파서 상한에서 잘렸을 수 있으므로 상한 없이 다시 파싱한다. 근거도 다시 파싱한 결과 기준이다.
     * 처음 파싱 결과와 같은 리댁션을 거친다.
     */
    const full = parseOutput(deps, state, 0);
    if (full.parsed != null && full.parseError === undefined) {
      source      = state.maskingOn ? (await redactParsedValue(full.parsed, state.patterns, { onFallback: info => state.fallbacks.push(info) })).value : full.parsed;
      complete    = true;
      rawEvidence = full.rawEvidence;
    }
  } else if (!complete) {
    complete = target.rows.length < maxItems;
  }
  const reshaped = state.projection !== undefined || state.pipeline !== undefined;
  const total    = (reshaped ? target.rows.length : rowArrayOf(source, shape?.rowsKey)?.rows.length) ?? target.rows.length;
  const shown    = target.rows.slice(0, output.preview_rows);
  const summary  = { total, shown: shown.length, truncated: true as const };
  return {
    final: withRows(final, target.key, shown, summary),
    autoRetain: { total, shown: shown.length, source, stored: reshaped ? final : source, complete, ...(rawEvidence && { rawEvidence }) },
  };
}

/** 적응형 형식: 보이는 행 수가 임계값을 넘으면 compact로 바꾸거나 원문을 뺀다. 근거와 예산을 요청했으면 쓰지 않는다. */
function adaptiveChoice(deps: RunDeps, state: RunState, projected: unknown, rows: { projected?: unknown[]; shown?: unknown[] }): { compact: boolean; dropRaw: boolean } {
  const threshold = deps.config.parsers?.adaptive_format_threshold;
  /** 근거를 요청했으면 적응형 compact를 켜지 않는다. 구조가 바뀌면 근거 포인터가 가리키는 대상이 사라진다. */
  if (!threshold || state.wantEvidence || state.opts.budget || !projected || typeof projected !== "object") return { compact: false, dropRaw: false };
  const arr = rows.shown ?? rows.projected ?? (Array.isArray(projected) ? projected : Object.values(projected).find(v => Array.isArray(v)) as unknown[] | undefined);
  if (!arr || arr.length === 0) return { compact: false, dropRaw: false };
  if ((threshold.json_no_raw ?? 0) > 0 && arr.length >= threshold.json_no_raw!) return { compact: true, dropRaw: true };
  if ((threshold.compact ?? 0) > 0 && arr.length >= threshold.compact!) return { compact: true, dropRaw: false };
  return { compact: false, dropRaw: false };
}

/** 응답 표현을 고른다. 적응형 compact와 원문 생략을 정한다. */
function chooseRepresentation(
  deps: RunDeps, state: RunState, projected: unknown,
  rows: { projected?: unknown[]; shown?: unknown[] }, parsed: unknown, parseError: ParseErrorField | undefined,
): { final: unknown; compactApplied: boolean; rawOmitted: boolean; representationFailure?: FailureInfo } {
  const includeRaw = state.opts.include_raw ?? (deps.config.output ?? DEFAULT_OUTPUT).include_raw;
  /** include_raw를 직접 요청했으면 json-no-raw 형식이 아닌 한 원문을 남긴다. */
  const keepRaw    = state.opts.include_raw === true && state.format !== "json-no-raw";
  const adaptive   = adaptiveChoice(deps, state, projected, rows);
  const useCompact = state.format === "compact" || adaptive.compact;
  /**
   * 파싱 결과가 손실 없이 있으면 원문을 싣지 않는다. 원문은 같은 정보를 한 번 더 싣는 것이다.
   * 원문이 필요하면 include_raw로 요청하거나 explain_result로 바이트 근거를 본다.
   */
  const dropRaw = !keepRaw && (
    (!includeRaw && parsed != null && parseError === undefined)
    || state.format === "json-no-raw" || rows.projected !== undefined || (state.parseWhole && parsed != null) || adaptive.dropRaw
  );
  if (!useCompact) return { final: projected, compactApplied: false, rawOmitted: dropRaw && projected !== null };
  /** compact 변환이 값을 보존할 수 없으면(순환, BigInt, 과도한 깊이) 원형 JSON을 두고 원문도 버리지 않는다. */
  const outcome = toCompact(projected);
  if (outcome.ok) return { final: outcome.value, compactApplied: true, rawOmitted: dropRaw && outcome.value !== null };
  return { final: projected, compactApplied: false, rawOmitted: false, representationFailure: { kind: "parse", reason: outcome.reason, message: outcome.message } };
}

/**
 * 파싱 실패를 failure로 정규화한다. 실행이 실패했거나 stdout 없이 stderr만 있으면 실행 쪽 failure를 유지한다.
 * 파서도 없고 native JSON도 아니면 parser_not_found(ok=true인 정보성 실패)다.
 */
function normalizeFailure(
  envelope: ResponseEnvelope, parsed: unknown, parseError: ParseErrorField | undefined, cmd: string, textPipe: boolean,
  projectionFailure: FailureInfo | undefined, representationFailure: FailureInfo | undefined,
): FailureInfo | undefined {
  const stderrOnly = envelope.stdout.raw.trim() === "" && envelope.stderr.raw.trim() !== "";
  let failure = envelope.failure;
  if (parseError && !textPipe) {
    if (envelope.failure === undefined && !stderrOnly) {
      failure = { kind: "parse", reason: parseError.reason, message: parseError.message, ...(parseError.hint && { hint: parseError.hint }) };
    }
  } else if (parsed === null && envelope.ok && !textPipe) {
    failure = { kind: "parse", reason: "parser_not_found", message: `No parser registered for '${cmd}'` };
  }
  return representationFailure ?? projectionFailure ?? failure;
}

/** 파싱 결과를 다듬는다: 실행하지 못한 러너, 경로 줄이기와 변경 귀속, fixed 필드 검사, 시크릿 리댁션 */
async function normalizeParsed(state: RunState, out: ReturnType<typeof parseOutput>): Promise<{
  parsed: unknown; parseError?: ParseErrorField; originTable?: OriginTable; redactions: number;
}> {
  let parsed     = out.parsed;
  let parseError = out.parseError;
  /** 러너가 실패로 끝났는데 읽을 출력이 없으면 결과를 만들지 않는다. 띄우지 못한 실행을 "오류 0건"으로 읽지 않는다. */
  if (state.parseWhole && state.envelope!.failure !== undefined && state.parseInput!.trim() === "") {
    parsed     = null;
    parseError = undefined;
  }
  if (state.parseWhole && parsed != null && !out.native) {
    parsed = relativizeReport(parsed, resolveRealCwd(state.cwd));
    if (state.opts.attribution !== false) parsed = await attributeReport(parsed, state.cwd);
  }
  /** 출처 분류표가 있는 파서는 fixed 필드의 형식을 검사한다. 기존 파서는 새 계약에서만, 시험·진단 파서는 항상 검사한다. */
  const originTable = out.native ? undefined : originTableFor(state.cmd, state.args);
  if (originTable && parsed != null && (state.wantReview || state.parseWhole)) {
    const violations = fixedViolations(parsed, originTable);
    if (violations.length > 0) {
      parsed     = null;
      parseError = { reason: "schema_violation", message: `fixed field check failed: ${violations.join("; ")}` };
    }
  }
  /** 리댁션을 켰으면 파싱 결과의 문자열도 가린다. 투영, 보관, 이어 읽기가 모두 가린 값을 쓴다. */
  let redactions = 0;
  if (state.maskingOn && parsed != null) {
    const masked = await redactParsedValue(parsed, state.patterns, { onFallback: info => state.fallbacks.push(info) });
    parsed     = masked.value;
    redactions = masked.count;
  }
  return { parsed, ...(parseError && { parseError }), ...(originTable && { originTable }), redactions };
}

/** 전체를 받아 파싱한 명령은 파싱에 실패했을 때만 원문을 상한에 맞춰 잘라 싣는다. stderr는 항상 자른다. */
function trimWholeOutput(state: RunState, envelope: ResponseEnvelope, parsed: unknown, maxBytes: number): ResponseEnvelope {
  if (!state.parseWhole) return envelope;
  const stdout = parsed == null ? truncateUtf8Lines(envelope.stdout.raw, maxBytes) : { text: envelope.stdout.raw, truncated: false };
  const stderr = truncateUtf8Lines(envelope.stderr.raw, maxBytes);
  return {
    ...envelope,
    stdout: { ...envelope.stdout, raw: stdout.text },
    stderr: { ...envelope.stderr, raw: stderr.text },
    ...((stdout.truncated || stderr.truncated) && { truncated: true }),
  };
}

/** 파이프 뒤 단계를 적용한다. 글자 모드면 응답의 stdout.raw를 단계 결과로 바꾼다. */
async function pipeStage(
  state: RunState, parsed: unknown, shape: { rowsKey?: string; rowFields?: readonly string[] } | undefined, envelope: ResponseEnvelope, maxBytes: number,
): Promise<{ input: unknown; envelope: ResponseEnvelope; text: boolean; mode?: "rows" | "text"; stages?: ProjectionStage[]; total?: number }> {
  if (!state.pipeline) return { input: parsed, envelope, text: false };
  const piped = await applyPipeline(state, parsed, shape);
  if (piped.raw === undefined) {
    return { input: piped.parsed, envelope, text: false, mode: piped.mode, ...(piped.stages && { stages: piped.stages }), ...(piped.total !== undefined && { total: piped.total }) };
  }
  const shown = truncateUtf8Lines(piped.raw, maxBytes);
  const next: ResponseEnvelope = { ...envelope, stdout: { raw: shown.text, parsed: null }, ...(shown.truncated && { truncated: true }) };
  if (!shown.truncated) delete next.truncated;
  return { input: null, envelope: next, text: true, mode: "text" };
}

/** 투영: where, sort_by, limit, select. 실패하면 결과를 비우고 failure.kind=config로 알린다. */
function projectStage(state: RunState, input: unknown, shape: { rowsKey?: string; rowFields?: readonly string[] } | undefined, maxItems: number): {
  projected: unknown; rows?: unknown[]; summary?: ProjectionSummary; failure?: FailureInfo;
} {
  if (!state.projection?.ok || input == null) return { projected: input };
  const p = applyProjection(input, state.projection.options, shape ?? (state.devloopRows ? { rowsKey: state.devloopRows } : undefined), maxItems);
  if (!p.ok) return { projected: null, failure: { kind: "config", reason: p.reason, message: p.message } };
  return { projected: p.parsed, rows: p.rows, ...(Array.isArray(p.parsed) && { summary: p.summary }) };
}

/**
 * 파이프 단계 뒤에 투영을 했으면 요약의 total을 명령이 낸 행 수로 되돌린다.
 * 투영은 파이프가 거른 행만 보므로 그대로 두면 total이 grep 뒤의 행 수가 되어 matched와 같아진다.
 */
function withPipeTotal<T extends { projected: unknown; summary?: ProjectionSummary }>(proj: T, total: number | undefined): T {
  if (total === undefined) return proj;
  if (proj.summary) return { ...proj, summary: { ...proj.summary, total } };
  const value = proj.projected as { _summary?: ProjectionSummary } | null;
  if (value && typeof value === "object" && !Array.isArray(value) && value._summary) {
    return { ...proj, projected: { ...value, _summary: { ...value._summary, total } } };
  }
  return proj;
}

/** 표현과 요약, 실패를 봉투에 넣는다. 결과가 최상위 배열이면 요약은 stdout._summary에 둔다. */
function assembleEnvelope(
  envelope: ResponseEnvelope, repr: { final: unknown; rawOmitted: boolean }, parseError: ParseErrorField | undefined,
  summary: ProjectionSummary | undefined, arrayPreview: { total: number; shown: number } | undefined, failure: FailureInfo | undefined,
): ResponseEnvelope {
  const extra = {
    ...(parseError && { parse_error: parseError }),
    ...(summary && { _summary: summary }),
    ...(arrayPreview && { _summary: { total: arrayPreview.total, matched: arrayPreview.total, shown: arrayPreview.shown, truncated: true as const } }),
  };
  const stdout = repr.rawOmitted ? { raw: "", parsed: repr.final, ...extra } : { ...envelope.stdout, parsed: repr.final, ...extra };
  const enriched: ResponseEnvelope = { ...envelope, stdout, ...(failure !== undefined && { failure }) };
  if (failure === undefined) delete enriched.failure;
  return enriched;
}

/** 투영이 실패했을 때 함께 싣는 원문의 상한(바이트) */
const PROJECTION_FAILURE_RAW_BYTES = 2048;

async function stageParseAndProject(deps: RunDeps, state: RunState): Promise<ParsedOutcome> {
  const config = deps.config;
  state.timer?.markStart("parse");
  /** 투영, 파이프, 자동 보관은 전체 행을 다뤄야 하므로 파서 상한을 끄고, 보이는 행을 max_items로 자른다. */
  const maxItems = state.projection || state.pipeline ? 0 : config.guard.max_items;
  const out      = parseOutput(deps, state, maxItems);
  const norm     = await normalizeParsed(state, out);
  const parsed   = norm.parsed;
  const trimmed  = trimWholeOutput(state, state.envelope!, parsed, config.guard.max_output_bytes);
  const piped    = await pipeStage(state, parsed, out.shape, trimmed, config.guard.max_output_bytes);
  const parseError = piped.text ? undefined : norm.parseError;
  const envelope = piped.envelope;
  const proj     = withPipeTotal(projectStage(state, piped.input, out.shape, config.guard.max_items), piped.total);

  const preview   = proj.projected != null ? await previewFor(deps, state, proj.projected, parsed, maxItems, out.shape) : { final: proj.projected };
  const shownRows = preview.autoRetain ? rowArrayOf(preview.final, out.shape?.rowsKey)?.rows : proj.rows;
  const chosen = chooseRepresentation(deps, state, preview.final, { ...(proj.rows && { projected: proj.rows }), ...(shownRows && { shown: shownRows }) },
    piped.text ? null : piped.input, parseError);
  /**
   * 투영(select·where·aggregate)이 실패하면 짧은 원문만 싣는다. 실패 메시지가 있는 필드 이름을 알려 주므로
   * 큰 원문까지 실으면 실패 하나가 수십만 바이트가 된다. 뺀 경우는 메시지에 크기와 다시 읽는 방법을 적는다.
   */
  const rawBytes   = Buffer.byteLength(envelope.stdout.raw, "utf8");
  const dropOnFail = proj.failure !== undefined && state.opts.include_raw !== true && rawBytes > PROJECTION_FAILURE_RAW_BYTES;
  const repr       = dropOnFail ? { ...chosen, rawOmitted: true } : chosen;
  if (dropOnFail) proj.failure!.message += ` (stdout of ${rawBytes} bytes omitted; rerun without select, where or aggregate to read it)`;
  const auto     = preview.autoRetain;
  const failure  = normalizeFailure(envelope, parsed, parseError, state.cmd, piped.text, proj.failure, repr.representationFailure);
  const enriched = assembleEnvelope(envelope, repr, parseError, proj.summary, auto && Array.isArray(preview.final) ? auto : undefined, failure);
  recordRun(deps, state.cmd, envelope.failure, parseError, piped.text ? "text" : parsed);
  state.timer?.markEnd("parse");
  return {
    parsed, ...(parseError && { parseError }), native: out.native, ...(norm.originTable && { originTable: norm.originTable }),
    rawEvidence: out.rawEvidence, ...(out.evidenceReason && { evidenceReason: out.evidenceReason }),
    maxItems, final: repr.final, compactApplied: repr.compactApplied, rawOmitted: repr.rawOmitted,
    ...(repr.representationFailure && { representationFailure: repr.representationFailure }),
    enriched, redactions: norm.redactions,
    ...(auto && { autoRetain: auto }),
    ...(piped.mode && { pipeMode: piped.mode }), ...(piped.stages && { pipeStages: piped.stages }),
  };
}

/** run 한 번의 결과를 센다(텔레메트리를 켰을 때만). */
function recordRun(deps: RunDeps, cmd: string, execFailure: FailureInfo | undefined, parseError: ParseErrorField | undefined, parsed: unknown): void {
  if (!deps.stats) return;
  if (execFailure)         deps.stats.record(cmd, "exec", execFailure.reason);
  else if (parseError)     deps.stats.record(cmd, parseError.reason);
  else if (parsed == null) deps.stats.record(cmd, "parser_not_found");
  else                     deps.stats.record(cmd, "parsed");
}

// ── 4. 마스킹과 재검토 ──────────────────────────────────────────────────────

interface Reviewed {
  enriched:   ResponseEnvelope;
  maskRanges: readonly MaskedRange[];
}

/** 정규 원문(마스킹 후)과 마스킹 구간. 근거와 해시의 기준이다. */
interface Canonical {
  stdout:     string;
  stderr:     string;
  ranges:     readonly MaskedRange[];
}

/** 원문, 실패 메시지, 파싱 오류 메시지를 가린다. 마스킹이 꺼져 있으면 그대로 둔다. */
async function maskOutputs(state: RunState, outcome: ParsedOutcome, enriched: ResponseEnvelope): Promise<{ enriched: ResponseEnvelope; canonical: Canonical }> {
  const execStdoutRaw = state.envelope!.stdout.raw;
  const execStderrRaw = state.envelope!.stderr.raw;
  if (!state.maskingOn) return { enriched, canonical: { stdout: execStdoutRaw, stderr: execStderrRaw, ranges: [] } };
  const opts      = { onFallback: (info: RegexFallback) => { state.fallbacks.push(info); } };
  const masked    = await maskWithRanges(execStdoutRaw, state.patterns, opts);
  const maskedErr = await maskWithRanges(execStderrRaw, state.patterns, opts);
  /** 응답에 실린 stdout.raw가 첫 명령의 원문과 다르면(파이프 글자 모드) 그 글자를 따로 가린다. */
  const shownRaw  = outcome.rawOmitted ? "" : enriched.stdout.raw === execStdoutRaw ? masked.text : await redact(enriched.stdout.raw, state.patterns, opts);
  const failure   = enriched.failure && { ...enriched.failure, message: await redact(enriched.failure.message, state.patterns, opts) };
  const parseErr  = enriched.stdout.parse_error && { ...enriched.stdout.parse_error, message: await redact(enriched.stdout.parse_error.message, state.patterns, opts) };
  return {
    enriched: {
      ...enriched,
      stdout: { ...enriched.stdout, raw: shownRaw, ...(parseErr && { parse_error: parseErr }) },
      stderr: { ...enriched.stderr, raw: maskedErr.text },
      ...(failure && { failure }),
    },
    canonical: { stdout: masked.text, stderr: maskedErr.text, ranges: masked.ranges },
  };
}

/** 보관본이 처음 실행 때 항목 수 상한 없이 파싱된 것인지 */
function sourceCompleteOf(state: RunState, outcome: ParsedOutcome): boolean {
  if (outcome.autoRetain) return outcome.autoRetain.complete;
  if (outcome.maxItems === 0) return true;
  return state.parseWhole && outcome.parsed != null && (outcome.parsed as { diagnostics_omitted?: number }).diagnostics_omitted === undefined;
}

/** 재검토 정보를 만들고, 보관을 요청했거나 자동 보관이면 결과를 보관함에 넣는다 */
function reviewAndRetain(deps: RunDeps, state: RunState, outcome: ParsedOutcome, enriched: ResponseEnvelope, canonical: Canonical): ResponseEnvelope {
  const auto      = outcome.autoRetain;
  const retainNow = state.wantRetain || auto !== undefined;
  const review = attachReview(enriched, {
    cmd: state.cmd, args: state.args, cwd: state.cwd,
    resultId:        mintResultId(),
    parsed:          auto?.source ?? outcome.parsed,
    final:           auto?.stored ?? outcome.final,
    native:          outcome.native,
    truncated:       enriched.truncated === true,
    silentEmpty:     outcome.parseError?.reason === "unrecognized_output",
    representation:  outcome.representationFailure === undefined,
    /** 자동 보관본은 표현 변환 전의 행을 담으므로 compact 여부와 관계없이 근거를 만든다. */
    compactApplied:  auto ? false : outcome.compactApplied,
    ...(outcome.evidenceReason && { evidenceReason: outcome.evidenceReason }),
    rawEvidence:     auto?.rawEvidence ?? outcome.rawEvidence,
    unmaskedStdout:  state.envelope!.stdout.raw,
    canonicalStdout: canonical.stdout, canonicalStderr: canonical.stderr, maskRanges: canonical.ranges,
    wantRetain:      retainNow,
    projection:      state.projection,
    sourceComplete:  sourceCompleteOf(state, outcome),
    ...(state.opts.context && { context: state.opts.context }),
  }, { results: deps.results, registry: deps.registry, config: deps.config });
  let out = state.wantReview ? { ...enriched, review } : enriched;
  if (auto) out = { ...out, ...autoRetainFields(auto, review.retained ? review.result_id : undefined) };
  else if (state.wantRetain && review.retained) out = { ...out, result_id: review.result_id };
  return out;
}

/** 출처 분류. 분류표가 결과와 맞으면 표로, 아니면 값의 형으로 분류하고 어느 쪽인지 basis에 적는다. */
function originOf(outcome: ParsedOutcome): ResponseEnvelope["_origin"] {
  const matched = outcome.originTable && tableForResult(outcome.originTable, outcome.parsed);
  const shown   = matched && Object.keys(matched).length > 0 ? matched : undefined;
  return shown
    ? { external: externalFields(shown), fixed: fixedFields(shown), basis: "table" as const }
    : { ...deriveOrigin(outcome.parsed), basis: "value_types" as const };
}

async function stageRedactAndReview(deps: RunDeps, state: RunState, outcome: ParsedOutcome): Promise<Reviewed> {
  state.timer?.markStart("redact");
  const masked = await maskOutputs(state, outcome, outcome.enriched);
  let enriched = masked.enriched;
  if (state.fallbacks.length > 0) enriched = { ...enriched, regex_engine: { used: "typescript", fallbacks: dedupeFallbacks(state.fallbacks) } };
  state.timer?.markEnd("redact");

  if (state.wantReview || state.wantRetain || outcome.autoRetain !== undefined) {
    enriched = reviewAndRetain(deps, state, outcome, enriched, masked.canonical);
    if (state.wantReview && outcome.parsed != null) enriched = { ...enriched, _origin: originOf(outcome) };
  }
  return { enriched, maskRanges: masked.canonical.ranges };
}

/** 같은 패턴의 되돌림 기록은 하나만 남긴다. 파싱 결과 리댁션과 원문 마스킹이 같은 패턴을 두 번 돈다. */
function dedupeFallbacks(list: readonly RegexFallback[]): RegexFallback[] {
  const seen = new Set<string>();
  return list.filter(f => {
    const key = `${f.pattern}\0${f.reason}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** 자동 보관 결과를 응답에 알리는 필드 */
function autoRetainFields(auto: NonNullable<ParsedOutcome["autoRetain"]>, resultId: string | undefined): Partial<ResponseEnvelope> {
  if (resultId) {
    return {
      result_id: resultId,
      _hint: `Showing ${auto.shown} of ${auto.total} rows. Call query_result with result_id "${resultId}" and where/select/sort_by/limit/aggregate to read the rest without re-running.`,
    };
  }
  return {
    _hint: `Showing ${auto.shown} of ${auto.total} rows. The full result was too large to keep; run again with where/select/limit to narrow it.`,
  };
}

// ── 5. 영수증, 변경 요약, 예산 ───────────────────────────────────────────────

async function stageReceiptAndBudget(deps: RunDeps, state: RunState, outcome: ParsedOutcome, reviewed: Reviewed): Promise<ResponseEnvelope> {
  let enriched = reviewed.enriched;
  const executed = state.executed!;

  /** 영수증은 계약 버전과 관계없이 디스크에 남긴다. 응답에는 새 계약에서만 싣는다. */
  if (deps.receipts) {
    const receipt = await issueReceipt(deps, {
      cmd: state.cmd, args: state.args, requestedArgs: state.requestedArgs, cwd: state.cwd, startedAt: state.startedAt,
      parsed:        outcome.parsed,
      exitCode:      executed.exitCode,
      durationMs:    executed.duration_ms,
      outputText:    state.reportText ?? executed.stdout.raw,
      truncated:     executed.truncated === true,
      failureReason: executed.failure && executed.failure.reason !== "non_zero_exit" ? executed.failure.reason : undefined,
    });
    if (state.wantReview && receipt) enriched = { ...enriched, receipt };
  }

  /** 로컬 저장소를 바꾼 git 실행은 바뀐 뒤의 상태를 함께 싣는다. 확인용 git status 호출이 필요 없다. */
  if (state.cmd === "git" && executed.failure?.reason !== "spawn_failed" && isMutatingGit(state.args)) {
    const delta = await gitDelta(state.cwd);
    if (delta) enriched = { ...enriched, _delta: delta };
  }

  if (state.pipeline) {
    enriched = { ...enriched, _compiled_pipeline: {
      original: state.pipeline.original,
      mode:     outcome.pipeMode ?? "text",
      stages:   state.pipeline.stages.map(stage => stage.map(quoteArg).join(" ")),
      ...(outcome.pipeStages && { promoted_stages: outcome.pipeStages }),
      ...((state.notes.length > 0 || state.pipeline.notes.length > 0) && { notes: [...state.notes, ...state.pipeline.notes] }),
    } };
  } else if (state.notes.length > 0) {
    enriched = { ...enriched, _command_notes: state.notes };
  }

  if (state.timer) enriched = { ...enriched, telemetry: state.timer.toField() };

  /** 예산은 리댁션과 재검토가 끝난 뒤 최종 크기로 확인한다. 사용자에게 나가는 payload에 대한 약속이어야 한다. */
  if (state.opts.budget) {
    const budgeted = applyRunBudget(enriched, state.opts.budget, {
      cmd: state.cmd, args: state.args, cwd: state.cwd, maskRanges: reviewed.maskRanges,
      parsed: outcome.parsed, projection: state.projection, native: outcome.native,
      /** 기본 계약에는 review 식별자가 없다. 이어 읽기 cursor를 내려면 fetch_result가 찾을 식별자로 보관해야 한다. */
      resultId: (state.wantReview ? enriched.review?.result_id : undefined) ?? mintResultId(),
    }, { registry: deps.registry, pages: deps.pages });
    const { shrunkParsed, ...surface } = budgeted;
    enriched = { ...enriched, ...surface, stdout: { ...enriched.stdout, parsed: shrunkParsed } };
  }

  recordStats(deps, state, outcome, enriched);
  return enriched;
}

function recordStats(deps: RunDeps, state: RunState, outcome: ParsedOutcome, enriched: ResponseEnvelope): void {
  if (!deps.statsLog) return;
  const executed = state.executed!;
  /** 러너가 보고서를 파일로 썼으면 명령이 낸 출력은 그 보고서다. */
  const rawText  = (state.reportText ?? executed.stdout.raw) + executed.stderr.raw;
  let   body: string;
  try {
    body = JSON.stringify(enriched);
    if (state.opts.delivery === "shell") {
      const parsed = enriched.stdout.parsed == null ? undefined : JSON.stringify(enriched.stdout.parsed);
      body = parsed !== undefined && (state.parseWhole || enriched.stdout.raw === "" || parsed.length < enriched.stdout.raw.length) ? parsed : enriched.stdout.raw;
    }
  } catch {
    /** 외부 파서가 순환 값이나 BigInt를 돌려주면 직렬화할 수 없다. 응답은 그대로 두고 크기만 세지 않는다. */
    body = "";
  }
  deps.statsLog.record({
    kind:             "run",
    cmd:              state.cmd,
    outcome:          executed.failure && executed.failure.reason !== "non_zero_exit" ? "exec_failed"
      : outcome.pipeMode === "text" ? "text" : outcome.parsed != null ? "parsed" : "unparsed",
    raw_bytes:        Buffer.byteLength(rawText, "utf8"),
    delivered_bytes:  Buffer.byteLength(body, "utf8"),
    raw_tokens:       countTokens(rawText),
    delivered_tokens: countTokens(body),
    ...(outcome.redactions > 0 && { redactions: outcome.redactions }),
    ...(enriched.result_id && outcome.autoRetain && { auto_retained: true as const }),
    ...(outcome.pipeMode && { pipe: outcome.pipeMode }),
  });
}

/**
 * 영수증을 만들어 디스크에 남긴다. 남기지 못하면 경고하고 undefined를 돌려준다.
 * 영수증 때문에 명령 결과가 실패로 바뀌지 않게 한다.
 */
async function issueReceipt(deps: RunDeps, input: {
  cmd: string; args: string[]; requestedArgs: string[]; cwd: string; startedAt: number; parsed: unknown;
  exitCode: number; durationMs: number; outputText: string; truncated: boolean; failureReason: string | undefined;
}): Promise<Receipt | undefined> {
  try {
    const limits    = deps.config.receipts ?? DEFAULT_RECEIPTS;
    const workspace = await workspaceState(input.cwd, {
      untrackedMaxFiles: limits.untracked_max_files, untrackedMaxBytes: limits.untracked_max_bytes,
    });
    const summary = summarize(input.parsed);
    const changed = input.requestedArgs.length !== input.args.length || input.requestedArgs.some((a, i) => a !== input.args[i]);
    const body: Receipt = {
      id:            newReceiptId(),
      cmd:           input.cmd,
      args:          input.args,
      ...(changed && { args_requested: input.requestedArgs }),
      cwd:           resolveRealCwd(input.cwd),
      exit_code:     input.exitCode,
      started_at:    new Date(input.startedAt).toISOString(),
      duration_ms:   input.durationMs,
      ...(summary && { summary }),
      output_sha256: sha256(input.outputText),
      ...(input.truncated && { truncated: true as const }),
      ...(input.failureReason && { failure_reason: input.failureReason }),
      ...(workspace && { workspace }),
    };
    return deps.receipts!.append(body, deps.receiptKey ? (r => signReceipt(r, deps.receiptKey!)) : undefined);
  } catch (err) {
    process.stderr.write(`[parism] WARNING: receipt was not written: ${(err as Error).message}\n`);
    return undefined;
  }
}

/** 러너 보고서 파일의 크기 상한. 실행기의 출력 버퍼 상한과 같다. */
const REPORT_MAX_BYTES = 10 * 1024 * 1024;

/** 러너가 쓴 보고서 파일을 읽는다. 파일이 없거나 상한을 넘으면 빈 문자열이다. */
function readReport(file: string): string {
  let fd: number | undefined;
  try {
    fd = openSync(file, "r");
    return fstatSync(fd).size > REPORT_MAX_BYTES ? "" : readFileSync(fd, "utf8");
  } catch {
    return "";
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** 실경로. 해석에 실패하면 절대 경로로 대체한다. */
export function resolveRealCwd(cwd: string): string {
  try {
    return realpathSync(cwd);
  } catch {
    return path.resolve(cwd);
  }
}

export type { ReceiptStore };
