/**
 * ParismEngine — 라이브러리 모드 진입점.
 * MCP 서버 없이 Node.js 소비자가 Parism 파이프라인을 직접 사용할 수 있도록 한다.
 *
 * 작성자: 최진호
 * 작성일: 2026-04-15
 */

import { realpathSync }                                                             from "node:fs";
import path                                                                         from "node:path";
import { loadConfig, loadConfigMultiLayer } from "../config/loader.js";
import type { PrismConfig }                                                         from "../config/loader.js";
import { createRegistry }                                                           from "../parsers/index.js";
import type { ParserRegistry }                                                      from "../parsers/registry.js";
import type { OutputFormat }                                                        from "../parsers/registry.js";
import type { FailureInfo, ParseErrorField, ResponseEnvelope }                      from "../types/envelope.js";
import { execute, truncateUtf8Lines }                                               from "../engine/executor.js";
import { checkGuard, GuardError }                                                   from "../engine/guard.js";
import { buildExecArgs, resolvePolicies }                                           from "../engine/policy.js";
import { PageCache }                                                                from "../engine/page-cache.js";
import { paginateLines }                                                            from "../engine/paginator.js";
import { Semaphore }                                                                from "../engine/semaphore.js";
import { redact, validatePatterns, DEFAULT_OUTPUT_REDACT_PATTERNS }                 from "../engine/redactor.js";
import { toCompact }                                                                from "../parsers/compact.js";
import { loadExternalParsers, externalParserOptions }                               from "../cli/auto-loader.js";
import { parismHome }                                                               from "../cli/paths.js";
import { OutcomeStats, PipelineTimer, type CommandOutcomeCounts }                  from "../engine/telemetry.js";
import { describeCommand, type CommandDescription, type CommandDescriptionFailure } from "./capabilities.js";
import { PROJECTION_SHAPE, applyProjection, hasProjection, parseProjection,
         type ProjectionOptions, type ProjectionSummary }                          from "../engine/projection.js";
import { PACKAGE_VERSION }                                                          from "../version.js";

export interface ExecOptions {
  args?:        string[];
  cwd?:         string;
  format?:      "json" | "compact" | "json-no-raw";
  includeDiff?: boolean;
}

/** run 옵션. select, where, sort_by, limit, array는 파싱 결과의 최상위 배열에 적용한다(engine/projection.ts). */
export interface RunOptions extends ExecOptions, Partial<ProjectionOptions> {}

export interface RunPagedOptions extends ExecOptions {
  page?:      number;
  page_size?: number;
}

/**
 * config에서 effective 리댁션 패턴을 결정한다.
 * - output_patterns가 undefined(미설정) → DEFAULT_OUTPUT_REDACT_PATTERNS 사용
 * - output_patterns가 [] (빈 배열 명시) → 빈 배열 사용 (사용자 의도적 비활성)
 * - output_patterns가 비어있지 않은 배열  → 해당 배열 사용 (defaults와 병합하지 않음)
 */
function resolveRedactPatterns(config: PrismConfig): string[] {
  const patterns = config.guard.secrets?.output_patterns;
  if (patterns === undefined) return DEFAULT_OUTPUT_REDACT_PATTERNS;
  return patterns;
}

/**
 * Guard 차단 시 반환하는 에러 봉투를 생성한다.
 * 직렬화된 출력과의 하위 호환성을 위해 guard_error 필드를 유지한다.
 */
function buildGuardErrorEnvelope(
  cmd: string, args: string[], cwd: string, err: GuardError,
): ResponseEnvelope {
  return buildRejectedEnvelope(cmd, args, cwd, { kind: "guard", reason: err.reason, message: err.message }, { reason: err.reason, message: err.message });
}

/**
 * 실행하지 않고 거부한 요청의 봉투. 메시지는 stderr.raw와 failure에 함께 둔다.
 */
function buildRejectedEnvelope(
  cmd: string, args: string[], cwd: string, failure: FailureInfo, guardError?: { reason: string; message: string },
): ResponseEnvelope {
  return {
    ok:          false,
    exitCode:    -1,
    cmd,
    args,
    cwd,
    duration_ms: 0,
    stdout:      { raw: "", parsed: null },
    stderr:      { raw: failure.message, parsed: null },
    diff:        null,
    ...(guardError && { guard_error: guardError }),
    failure,
  };
}

/** RunOptions에서 값이 있는 투영 인자만 모은다. */
function projectionInput(opts: RunOptions | undefined): Record<string, unknown> {
  const input: Record<string, unknown> = {};
  if (!opts) return input;
  for (const key of Object.keys(PROJECTION_SHAPE) as (keyof ProjectionOptions)[]) {
    if (opts[key] !== undefined) input[key] = opts[key];
  }
  return input;
}

const PAGE_CACHE_TTL_MS      = 30_000;
const PAGE_CACHE_MAX_ENTRIES = 16;
const PAGE_CACHE_MAX_BYTES   = 32 * 1024 * 1024;

/** 설정에 동시 실행 상한이 없을 때(이전 형식의 설정 객체) 쓰는 값 */
const DEFAULT_MAX_CONCURRENCY = 4;

/** 설정에 page_size 상한이 없을 때(이전 형식의 설정 객체) 쓰는 값 */
const DEFAULT_MAX_PAGE_SIZE = 1000;

/**
 * 세마포어에 쓸 동시 실행 상한. 검증을 거치지 않은 설정 객체도 받으므로
 * 값이 없거나 유한한 수가 아니면 기본값을, 1 미만이면 1을 쓰고 소수는 버린다.
 */
function concurrencyLimit(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return DEFAULT_MAX_CONCURRENCY;
  return Math.max(1, Math.floor(value));
}

export class ParismEngine {
  private readonly pageCache = new PageCache(PAGE_CACHE_TTL_MS, PAGE_CACHE_MAX_ENTRIES, PAGE_CACHE_MAX_BYTES);
  /** 자식 프로세스 동시 실행 상한. 넘는 요청은 자리가 날 때까지 대기한다. */
  private readonly execSlots: Semaphore;
  /** 텔레메트리를 켰을 때만 있는 명령별 결과 카운터 */
  private readonly stats:     OutcomeStats | null;

  constructor(
    private readonly config:   PrismConfig,
    private readonly registry: ParserRegistry,
  ) {
    this.execSlots = new Semaphore(concurrencyLimit(config.guard.max_concurrency));
    this.stats     = config.telemetry?.enabled === true ? new OutcomeStats(config.guard.allowed_commands) : null;
  }

  /**
   * Guard 검사 → 실행 → JSON 파싱 파이프라인.
   * buildRunResult의 비즈니스 로직을 그대로 이전한다.
   */
  async run(cmd: string, opts?: RunOptions): Promise<ResponseEnvelope> {
    const args        = opts?.args        ?? [];
    const cwd         = opts?.cwd         ?? process.cwd();
    const format      = (opts?.format     ?? "json") as OutputFormat;
    const includeDiff = opts?.includeDiff ?? false;
    const telemetryEnabled = this.config.telemetry?.enabled === true;
    const timer = telemetryEnabled ? new PipelineTimer() : null;

    timer?.markStart("guard");
    try {
      checkGuard(cmd, args, cwd, this.config);
    } catch (err) {
      if (err instanceof GuardError) {
        this.stats?.record(cmd, "guard", err.reason);
        return buildGuardErrorEnvelope(cmd, args, cwd, err);
      }
      throw err;
    }
    timer?.markEnd("guard");

    const requested  = projectionInput(opts);
    const projection = hasProjection(requested) ? parseProjection(requested) : undefined;
    if (projection && !projection.ok) {
      return buildRejectedEnvelope(cmd, args, cwd, { kind: "config", reason: projection.reason, message: projection.message });
    }

    timer?.markStart("exec");
    const executed = await this.execSlots.run(() => execute(
      cmd, buildExecArgs(cmd, args, this.config.guard), cwd,
      this.config.guard.secrets?.env_patterns ?? [],
      this.config.guard.timeout_ms,
      this.config.guard.max_output_bytes,
      includeDiff,
    ));
    const envelope = { ...executed, args };
    timer?.markEnd("exec");
    timer?.setRawBytes(Buffer.byteLength(envelope.stdout.raw, "utf8"));

    timer?.markStart("parse");
    const parseFormat   = format === "json-no-raw" ? "json" : format;
    const strictSchemas = this.config.parsers?.strict_schemas ?? false;

    /** 투영은 전체 행에 where와 sort_by를 적용해야 하므로 파서 상한을 끄고, 보이는 행을 max_items로 자른다. */
    const maxItems    = projection ? 0 : this.config.guard.max_items;
    const parseResult = this.registry.parseWithFallback(cmd, args, envelope.stdout.raw, { maxItems, format: parseFormat }, strictSchemas);
    const parsed      = parseResult.parsed;

    /**
     * 투영: where, sort_by, limit, select. 성공하면 raw를 싣지 않는다(raw는 투영 전 전체 출력이다).
     * 실패하면 parsed를 비우고 raw를 남기며 failure.kind=config로 알린다.
     */
    let projected: unknown                       = parsed;
    let projectedRows: unknown[] | undefined;
    let arraySummary: ProjectionSummary | undefined;
    let projectionFailure: FailureInfo | undefined;
    if (projection?.ok && parsed != null) {
      const shape = parseResult.native ? undefined : this.registry.contractFor(cmd, args);
      const out   = applyProjection(parsed, projection.options, shape, this.config.guard.max_items);
      if (out.ok) {
        projected     = out.parsed;
        projectedRows = out.rows;
        if (Array.isArray(out.parsed)) arraySummary = out.summary;
      } else {
        projected         = null;
        projectionFailure = { kind: "config", reason: out.reason, message: out.message };
      }
    }

    // adaptive format: 항목 수 기준 자동 포맷 선택. 투영했으면 투영한 행 수를 본다.
    let useCompact  = parseFormat === "compact";
    let dropRaw     = format === "json-no-raw" || projectedRows !== undefined;
    const threshold = this.config.parsers?.adaptive_format_threshold;
    if (threshold && projected && typeof projected === "object") {
      const arr = projectedRows ?? (Array.isArray(projected) ? projected : Object.values(projected).find(v => Array.isArray(v)) as unknown[] | undefined);
      if (arr && arr.length > 0) {
        if (threshold.json_no_raw !== undefined && threshold.json_no_raw > 0 && arr.length >= threshold.json_no_raw) {
          useCompact = true;
          dropRaw    = true;
        } else if (threshold.compact !== undefined && threshold.compact > 0 && arr.length >= threshold.compact) {
          useCompact = true;
        }
      }
    }

    const final = useCompact ? toCompact(projected) : projected;
    /** native JSON 폴백이 성공하면 parseWithFallback이 unsupported_format을 결과에서 뺀다. */
    const parseError   = parseResult.parse_error;
    const extra        = { ...(parseError && { parse_error: parseError }), ...(arraySummary && { _summary: arraySummary }) };
    const stdout       = dropRaw && final !== null
      ? { raw: "", parsed: final, ...extra }
      : { ...envelope.stdout, parsed: final, ...extra };

    /**
     * parse failure 정규화: 파싱 오류는 failure로 승격, parser_not_found는 ok=true인 정보성 실패.
     * 실행이 실패했거나(종료 코드, 시간 초과, 스폰 실패) stdout 없이 stderr만 있으면 파싱 오류는 stdout.parse_error에만 남기고
     * failure는 실행 결과의 것을 유지한다. 원인은 실행 쪽에 있고 그 메시지가 stderr에 있기 때문이다.
     */
    const stderrOnly = envelope.stdout.raw.trim() === "" && envelope.stderr.raw.trim() !== "";
    let parseFailure = envelope.failure;
    if (parseError) {
      if (envelope.failure === undefined && !stderrOnly) {
        parseFailure = { kind: "parse", reason: parseError.reason, message: parseError.message, ...(parseError.hint && { hint: parseError.hint }) };
      }
    } else if (parsed === null && envelope.ok) {
      // 파서도 없고 native JSON도 아닐 때: parser_not_found (ok=true 유지 — 정보성 실패)
      parseFailure = { kind: "parse", reason: "parser_not_found", message: `No parser registered for '${cmd}'` };
    }
    if (projectionFailure) parseFailure = projectionFailure;
    this.recordRun(cmd, envelope.failure, parseError, parsed);
    timer?.markEnd("parse");

    let enriched = parseFailure !== undefined
      ? { ...envelope, stdout, failure: parseFailure }
      : { ...envelope, stdout };

    timer?.markStart("redact");
    if (this.config.guard.secrets?.output_redaction_enabled === true) {
      const patterns = validatePatterns(resolveRedactPatterns(this.config));
      enriched = {
        ...enriched,
        stdout:  { ...enriched.stdout, raw: redact(enriched.stdout.raw, patterns) },
        stderr:  { ...enriched.stderr, raw: redact(enriched.stderr.raw, patterns) },
      };
    }
    timer?.markEnd("redact");

    if (timer) {
      enriched = { ...enriched, telemetry: timer.toField() };
    }

    return enriched as ResponseEnvelope;
  }

  /**
   * 현재 환경 정보를 반환한다. 에이전트가 사용 가능한 명령, 파서, guard 제한을 파악할 수 있다.
   * cmd를 주면 그 명령의 유효 정책, 파서 형식, 대체 형식 안내, 예시만 돌려준다(facade/capabilities.ts).
   * 허용되지 않은 명령이면 예외 대신 failure를 담은 결과다.
   */
  describe(): DescribeResult;
  describe(cmd: string): CommandDescription | CommandDescriptionFailure;
  describe(cmd?: string): DescribeResult | CommandDescription | CommandDescriptionFailure {
    if (cmd !== undefined) {
      const result = describeCommand(this.config, this.registry, cmd);
      return this.stats && !("failure" in result) ? { ...result, stats: this.stats.forCommand(cmd) } : result;
    }
    const guard = this.config.guard;
    return {
      version:            PACKAGE_VERSION,
      allowed_commands:   [...guard.allowed_commands],
      available_parsers:  [...new Set([...this.registry.listCommands(), ...this.registry.listPacks()])],
      guard_summary: {
        block_patterns:          [...guard.block_patterns],
        allowed_paths:           [...guard.allowed_paths],
        timeout_ms:              guard.timeout_ms,
        max_output_bytes:        guard.max_output_bytes,
        command_arg_restrictions: Object.fromEntries(
          Object.entries(guard.command_arg_restrictions).map(([k, v]) => [k, { ...v }]),
        ),
        profile:                 guard.profile ?? "readonly",
        policies:                Object.fromEntries(
          Object.entries(resolvePolicies(guard)).map(([k, p]) => [k, {
            ...(p.subcommands && { subcommands: [...p.subcommands] }),
            flags:       Object.keys(p.flags),
            positionals: p.positionals,
          }]),
        ),
      },
      telemetry_enabled: this.config.telemetry?.enabled === true,
      ...(this.stats && { stats: this.stats.snapshot() }),
    };
  }

  /**
   * run 한 번의 결과를 센다(텔레메트리를 켰을 때만). 실행 실패가 있으면 그 사유를, 없으면 파싱 결과를 센다.
   * native JSON 폴백이 결과를 냈으면 parsed다. 투영 인자 오류는 파싱 결과와 무관하므로 세지 않는다.
   */
  private recordRun(cmd: string, execFailure: FailureInfo | undefined, parseError: ParseErrorField | undefined, parsed: unknown): void {
    if (!this.stats) return;
    if (execFailure)         this.stats.record(cmd, "exec", execFailure.reason);
    else if (parseError)     this.stats.record(cmd, parseError.reason);
    else if (parsed == null) this.stats.record(cmd, "parser_not_found");
    else                     this.stats.record(cmd, "parsed");
  }

  /**
   * 실제 실행 없이 guard 통과 여부만 확인한다.
   */
  dryRun(cmd: string, args: string[] = [], cwd: string = process.cwd()): DryRunResult {
    try {
      checkGuard(cmd, args, cwd, this.config);
      return { would_pass: true };
    } catch (err) {
      if (err instanceof GuardError) {
        return {
          would_pass: false,
          reason:     err.reason,
          message:    err.message,
        };
      }
      return {
        would_pass: false,
        reason:     "unknown",
        message:    err instanceof Error ? err.message : String(err),
      };
    }
  }

  /**
   * Guard 검사 → 실행 → 페이지 분할 파이프라인.
   * buildPagedResult의 비즈니스 로직을 그대로 이전한다.
   */
  async runPaged(cmd: string, opts?: RunPagedOptions): Promise<ResponseEnvelope> {
    const args        = opts?.args        ?? [];
    const cwd         = opts?.cwd         ?? process.cwd();
    const includeDiff = opts?.includeDiff ?? false;
    const page        = opts?.page        ?? 0;
    const requested   = opts?.page_size   ?? this.config.guard.default_page_size;
    const maxPageSize = this.config.guard.max_page_size ?? DEFAULT_MAX_PAGE_SIZE;
    const pageSize    = Math.min(requested, maxPageSize);

    try {
      checkGuard(cmd, args, cwd, this.config);
    } catch (err) {
      if (err instanceof GuardError) {
        this.stats?.record(cmd, "guard", err.reason);
        return buildGuardErrorEnvelope(cmd, args, cwd, err);
      }
      throw err;
    }

    /**
     * 페이지를 나누려면 전체 stdout이 필요하므로 실행 단계에서는 max_output_bytes를 적용하지 않는다(0).
     * 실행 단계의 상한은 실행기의 버퍼 상한(10MB, executor.ts)이고, max_output_bytes는 잘라낸 페이지에 적용한다.
     */
    const cacheKey = JSON.stringify([cmd, args, resolveRealCwd(cwd), includeDiff]);
    const cached   = page > 0 ? this.pageCache.get(cacheKey) : undefined;
    let envelope: ResponseEnvelope;
    let cacheInfo: { hit: boolean; age_ms: number };
    if (cached) {
      envelope  = cached.envelope;
      cacheInfo = { hit: true, age_ms: Date.now() - cached.createdAt };
    } else {
      const executed = await this.execSlots.run(() => execute(
        cmd, buildExecArgs(cmd, args, this.config.guard), cwd,
        this.config.guard.secrets?.env_patterns ?? [],
        this.config.guard.timeout_ms,
        0,
        includeDiff,
      ));
      envelope  = { ...executed, args };
      if (envelope.ok) this.pageCache.set(cacheKey, { envelope, createdAt: Date.now() });
      /** run_paged는 파싱하지 않으므로 실행 실패만 센다. */
      if (envelope.failure) this.stats?.record(cmd, "exec", envelope.failure.reason);
      cacheInfo = { hit: false, age_ms: 0 };
    }
    const { lines, page_info }   = paginateLines(envelope.stdout.raw, page, pageSize);
    page_info.cache              = cacheInfo;
    if (pageSize < requested) page_info.requested_page_size = requested;
    const maxBytes               = this.config.guard.max_output_bytes;
    const pagedOut               = truncateUtf8Lines(lines.join("\n") + (lines.length > 0 ? "\n" : ""), maxBytes);
    const pagedErr               = truncateUtf8Lines(envelope.stderr.raw, maxBytes);
    const truncated              = envelope.truncated || pagedOut.truncated || pagedErr.truncated ? true : undefined;
    let   enriched               = {
      ...envelope,
      stdout:    { raw: pagedOut.text, parsed: null as null },
      stderr:    { ...envelope.stderr, raw: pagedErr.text },
      page_info,
      ...(truncated && { truncated }),
    };

    if (this.config.guard.secrets?.output_redaction_enabled === true) {
      const patterns = validatePatterns(resolveRedactPatterns(this.config));
      enriched = {
        ...enriched,
        stdout:  { ...enriched.stdout, raw: redact(enriched.stdout.raw, patterns) },
        stderr:  { ...enriched.stderr, raw: redact(enriched.stderr.raw, patterns) },
      };
    }

    return enriched as ResponseEnvelope;
  }
}

/** 캐시 키용 실경로. 해석에 실패하면 절대 경로로 대체한다. */
function resolveRealCwd(cwd: string): string {
  try {
    return realpathSync(cwd);
  } catch {
    return path.resolve(cwd);
  }
}

/**
 * 기본 설정과 파서 레지스트리로 ParismEngine 인스턴스를 생성한다.
 * 다층 설정(global/project/env)을 자동으로 로드한다.
 */
export async function createEngine(opts?: { configPath?: string }): Promise<ParismEngine> {
  const config = opts?.configPath ? await loadConfig(opts.configPath) : await loadConfigMultiLayer();
  const registry = createRegistry();
  const loaded = await loadExternalParsers(parismHome(), registry, externalParserOptions(config.parsers));
  if (loaded > 0) {
    process.stderr.write(`[parism] Loaded ${loaded} external parser(s)\n`);
  }
  return new ParismEngine(config, registry);
}

export type { CommandDescription, CommandDescriptionFailure } from "./capabilities.js";

/** describe() 반환 타입. */
export interface DescribeResult {
  version:            string;
  allowed_commands:   string[];
  available_parsers:  string[];
  guard_summary: {
    block_patterns:          string[];
    allowed_paths:           string[];
    timeout_ms:              number;
    max_output_bytes:        number;
    command_arg_restrictions: Record<string, { blocked_flags?: string[]; allowed_flags?: string[] }>;
    profile:                 "readonly" | "build";
    policies:                Record<string, { subcommands?: string[]; flags: string[]; positionals: string }>;
  };
  telemetry_enabled:  boolean;
  /** 텔레메트리를 켰을 때만 있는 명령별 결과 횟수. 프로세스 안에만 있고 재시작하면 비워진다. */
  stats?:             Record<string, CommandOutcomeCounts>;
}

/** dryRun() 반환 타입. */
export interface DryRunResult {
  would_pass: boolean;
  reason?:    string;
  message?:   string;
}
