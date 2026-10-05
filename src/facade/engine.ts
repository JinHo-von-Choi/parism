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
import { countJsonTokens }                                                       from "../engine/budget/tokenizer.js";
import { applyBudget, decodeCursor, makeCursor, validateTokenizer, budgetTooSmall,
         findRowArray, replaceRows, MINIMUM_ENVELOPE_TOKENS }                    from "../engine/budget/index.js";
import type { Continuation, CursorBinding }                                        from "../engine/budget/index.js";
import { buildFingerprint, type UserContext }                                      from "../engine/compare/fingerprint.js";
import { compareResults, type CompareOptions, type CompareResult, type CompareSide } from "../engine/compare/index.js";
import { ResultStore, resolvePointer, type StoredResult }                           from "../engine/result-store.js";
import { buildLineIndex, hashContent, type FieldEvidence, type RawEvidence, type SourceSpan } from "../engine/evidence.js";
import { buildReview, evidenceToByteSpans, mintResultId, sliceByBytes, verifySpans, ENVELOPE_SCHEMA_VERSION } from "../engine/review.js";
import { maskWithRanges, type MaskedRange }                                          from "../engine/mask-map.js";
import type { ReviewField }                                                          from "../types/envelope.js";

/**
 * 예산 보고의 **크기만** 재는 자리표.
 *
 * 예산을 적용할 때 응답에 예산 보고가 붙는데, 그 보고는 **검색이 끝난 뒤에** 붙는다.
 * 그러면 소비자가 실제로 받는 응답이 재었던 것보다 커진다.
 *
 * 실측: `max_tokens: 1400` 요청 → 보고 기준 `measured_tokens: 1330`, `budget_met: true`
 * → **실제 전달 1,939 토큰. 상한의 138%다.** `budget_met: true` 는 소비자가 지불하는
 * 비용에 대해 참이 아니었고, SPECIFICATION 의 정의("최종 payload 를 실제로 센 수")와 어긋났다.
 *
 * 그래서 **검색 단계부터 보고 자리를 함께 센다.** 자기 참조 필드(`measured_tokens`)만
 * 자리표수로 두고 나머지 키는 실제와 같은 모양·길이를 준다. 자릿수 차이는 확인 단계에서 잡는다.
 */
function budgetReportPlaceholder(maxTokens: number, tokenizerId: string): Record<string, unknown> {
  return {
    requested: { max_tokens: maxTokens, tokenizer: tokenizerId },
    /** 실제 값과 같은 자릿수가 되도록 4자리로 맞춘다 */
    measured_tokens: 1000,
    tokenizer_id: tokenizerId,
    tokenizer_version: "1.0.0",
    budget_met: true,
    tokenizer_exact: false,
    tokenizer_scope: "parism-json-payload-only",
  };
}

export interface ExecOptions {
  args?:        string[];
  cwd?:         string;
  format?:      "json" | "compact" | "json-no-raw";
  includeDiff?: boolean;
}

/** run 옵션. select, where, sort_by, limit, array는 파싱 결과의 최상위 배열에 적용한다(engine/projection.ts). */
export interface RunOptions extends ExecOptions, Partial<ProjectionOptions> {
  /**
   * 응답 계약 버전. 'next' 를 주면 review 와 근거가 실린다.
   * 기본값은 'stable' 이고, 결과에 새 필드가 붙지 않아 기존 소비자는 그대로 동작한다.
   */
  contract_version?: "stable" | "next";
  /** 근거를 어디까지 구할지. 'none' 이면 review 만 두고 근거는 계산하지 않는다(기본값). */
  evidence?:      "none" | "rows" | "fields";
  /** 결과를 세션에 보관해 explain_result 로 다시 볼 수 있게 한다. */
  retain?:        boolean;
  /**
   * 토큰 예산. 이미 얻은 결과를 어디까지 내보낼지 정한다 — 실행시간이나 수집량을 줄이는 기능이 아니다.
   * 필요한 필드가 빠지면 조용히 내보내지 않고 명시적으로 실패한다.
   */
  budget?: {
    max_tokens:      number;
    tokenizer?:      string;
    required_fields?: string[];
    overflow?:       "page" | "error";
  };
  /**
   * 사용자가 명시한 실행 문맥(예: kubectl context).
   * 지문의 일부로 비교에 쓰이지만 env 전체를 담지 않는다 — 환경 변수는 '이름'만 관찰 기록에 남긴다.
   */
  context?:      UserContext;
}

/** explain_result 의 결과. 재실행 없이 보관된 값만 돌려준다. */
/**
 * 보관본이 차지하는 바이트를 센다.
 *
 * **이미 한도를 넘었으면 계산을 멈춘다.** 원문만으로 한도를 넘긴 결과는
 * 그 뒤를 재어도 '버려질 결과' 라는 사실이 바뀌지 않는다. 그런데 1MB 출력을
 * 파싱한 본문 전체를 직렬화해 재는 비용은 크고, 그 결과는 아무것도 바꾸지 못한다.
 *
 * 순서도 의미가 있다 — 싼 것(문자열 길이)부터 재고, 비싼 것(직렬화)을 마지막에 본다.
 */
function storedBytesOf(
  input: { canonicalStdout: string; canonicalStderr: string; final: unknown },
  evidence: Record<string, FieldEvidence[]>,
  cap: number,
): number {
  let total = Buffer.byteLength(input.canonicalStdout, "utf8") + Buffer.byteLength(input.canonicalStderr, "utf8");
  if (total > cap) return cap + 1;

  total += Buffer.byteLength(JSON.stringify(input.final ?? null, null, 2), "utf8");
  if (total > cap) return cap + 1;

  return total + evidenceBytes(evidence, cap - total);
}

/**
 * 근거 맵이 차지하는 바이트를 센다.
 *
 * 항목 하나씩 직렬화해 누적하고, **상한을 넘으면 즉시 멈춘다.** 이미 "거절"이라는 결론이
 * 났으므로 그 이상 정확한 값은 쓸 곳이 없다. 이 조기 종료가 없으면 한도를 초과할수록
 * 버릴 결과를 끝까지 재게 되어, 한도를 정한 것 자체가 비용이 된다.
 */
function evidenceBytes(evidence: Record<string, FieldEvidence[]>, cap: number): number {
  let total = 0;
  for (const [pointer, list] of Object.entries(evidence)) {
    for (const item of list) {
      total += Buffer.byteLength(JSON.stringify([pointer, item.value, item.source_kind, item.source_spans, item.transform, item.masked, item.reason]), "utf8");
      if (total > cap) return cap + 1;
    }
  }
  return total;
}

export type ExplainResult =
  | {
      ok: true;  result_id: string; pointer: string; value: unknown;
      source_kind: "verbatim" | "derived" | "none"; source_spans: SourceSpan[];
      transform?: string; masked?: boolean; quoted?: string[];
      age_ms: number; review: ReviewField; reason?: string;
    }
  | {
      ok: false; result_id: string; pointer?: string;
      reason: "unknown_id" | "expired" | "evicted" | "not_retained" | "unknown_pointer";
      message: string;
    };

/** fetch_result 의 결과. 재실행 없이 저장된 같은 결과에서 다음 페이지만 돌려준다. */
export type FetchResult =
  | {
      ok: true; result_id: string; offset: number; returned: number; total: number;
      value: unknown; continuation?: Continuation;
    }
  | {
      ok: false; reason:
        | "cursor_invalid" | "cursor_mismatch" | "unknown_id" | "not_retained" | "expired" | "evicted"
        | "no_continuation" | "tokenizer_unsupported";
      message: string;
    };

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
  /** retain=true 로 요청한 결과를 보관해 explain_result 로 다시 본다. 메모리에만 있고 디스크에 남지 않는다. */
  private readonly results:   ResultStore;
  /** 예산 안에 잘라 낸 결과의 원본 행을 보관해 이어 읽기가 재실행 없이 되게 한다. */
  private readonly pages:     Map<string, { rows: unknown[]; binding: CursorBinding }> = new Map();

  constructor(
    private readonly config:   PrismConfig,
    private readonly registry: ParserRegistry,
  ) {
    this.execSlots = new Semaphore(concurrencyLimit(config.guard.max_concurrency));
    this.stats     = config.telemetry?.enabled === true ? new OutcomeStats(config.guard.allowed_commands) : null;
    this.results   = new ResultStore();
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
    /**
     * 예산 검사는 실행 전에 한다. 최소 봉투조차 담지 못하는 예산을 실행한 뒤에야 알리면
     * 명령만 실행되고 아무 값도 못 받는 결과가 된다.
     */
    if (opts?.budget) {
      const tokenizer = validateTokenizer(opts.budget.tokenizer);
      if (!tokenizer.ok) {
        return buildRejectedEnvelope(cmd, args, cwd, { kind: "config", reason: "tokenizer_unsupported", message: tokenizer.message });
      }
      if (budgetTooSmall(opts.budget, tokenizer.id)) {
        return buildRejectedEnvelope(cmd, args, cwd, {
          kind: "config", reason: "budget_too_small",
          message: `max_tokens ${opts.budget.max_tokens} cannot hold the minimal envelope (about ${MINIMUM_ENVELOPE_TOKENS} tokens); the command was not run`,
        });
      }
    }

    /** 새 계약은 opt-in 이다. 아무것도 요구하지 않으면 응답에 새 필드가 붙지 않는다. */
    const wantReview  = opts?.contract_version === "next";
    const evidenceLevel = (opts?.evidence ?? "none") as "none" | "rows" | "fields";
    const wantRetain  = opts?.retain === true && wantReview;
    const wantEvidence = wantReview && evidenceLevel !== "none";
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

    /**
     * 투영은 전체 행에 where와 sort_by를 적용해야 하므로 파서 상한을 끄고, 보이는 행을 max_items로 자른다.
     * 파싱과 투영용 계약 조회는 외부 파서의 시간 상한 하나를 함께 쓴다.
     */
    const maxItems = projection ? 0 : this.config.guard.max_items;
    /**
     * 근거를 요청했을 때만 근거까지 얻는다. 기본 경로는 그대로 둔다(레거시 응답에 근거를 지어내지 않는다).
     */
    let rawEvidence: RawEvidence = {};
    let evidenceReason: string | undefined;
    const { parseResult, shape } = this.registry.withCallDeadline(cmd, () => {
      const result = wantEvidence
        ? this.registry.parseWithFallbackWithEvidence(cmd, args, envelope.stdout.raw, { maxItems, format: parseFormat }, strictSchemas)
        : this.registry.parseWithFallback(cmd, args, envelope.stdout.raw, { maxItems, format: parseFormat }, strictSchemas);
      if (wantEvidence) {
        const withEvidence = result as { evidence?: RawEvidence; evidenceReason?: string };
        rawEvidence    = withEvidence.evidence ?? {};
        evidenceReason = withEvidence.evidenceReason;
      }
      const needed = projection?.ok === true && result.parsed != null && !result.native;
      return { parseResult: result, shape: needed ? this.registry.contractFor(cmd, args) : undefined };
    });
    const parsed = parseResult.parsed;
    const native = "native" in parseResult ? parseResult.native === true : false;

    /**
     * 투영: where, sort_by, limit, select. 성공하면 raw를 싣지 않는다(raw는 투영 전 전체 출력이다).
     * 실패하면 parsed를 비우고 raw를 남기며 failure.kind=config로 알린다.
     */
    let projected: unknown                       = parsed;
    let projectedRows: unknown[] | undefined;
    let arraySummary: ProjectionSummary | undefined;
    let projectionFailure: FailureInfo | undefined;
    if (projection?.ok && parsed != null) {
      const out = applyProjection(parsed, projection.options, shape, this.config.guard.max_items);
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
    /**
     * 근거를 요청한 경우에는 적응형 compact 를 켜지 않는다.
     * compact 는 표로 접어 버리면 결과 구조가 바뀌어 근거 포인터가 가리키는 대상이 사라진다.
     * 근거는 '어디서 나왔나'를 묻는 요청이므로 구조 훼손을 감수하지 않는다.
     */
    if (threshold && !wantEvidence && !opts?.budget && projected && typeof projected === "object") {
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

    /**
     * compact 변환은 값을 보존할 수 없을 때 실패를 돌린다(순환, BigInt, 과도한 깊이).
     * 실패하면 압축하지 않고 원형 JSON 을 그대로 두고, raw 도 버리지 않는다.
     */
    let   representationFailure: FailureInfo | undefined;
    let   final: unknown              = projected;
    let   compactApplied             = false;
    if (useCompact) {
      const outcome = toCompact(projected);
      if (outcome.ok) {
        final          = outcome.value;
        compactApplied = true;
      } else {
        representationFailure = { kind: "parse", reason: outcome.reason, message: outcome.message };
        dropRaw = false;
      }
    }
    /** native JSON 폴백이 성공하면 parseWithFallback이 unsupported_format을 결과에서 뺀다. */
    const parseError   = parseResult.parse_error;
    const extra        = { ...(parseError && { parse_error: parseError }), ...(arraySummary && { _summary: arraySummary }) };
    /**
     * 적응형 포맷이 원문을 응답에서 빼더라도 근거와 해시는 실제 출력을 가리켜야 한다.
     * 보관본과 오프셋 계산은 응답 모양이 아니라 실제 원문 기준이다.
     */
    const execStdoutRaw = envelope.stdout.raw;
    const execStderrRaw = envelope.stderr.raw;

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
    if (representationFailure) parseFailure = representationFailure;
    this.recordRun(cmd, envelope.failure, parseError, parsed);
    timer?.markEnd("parse");

    let enriched = parseFailure !== undefined
      ? { ...envelope, stdout, failure: parseFailure }
      : { ...envelope, stdout };

    timer?.markStart("redact");
    /**
     * 근거의 바이트 구간은 사용자에게 보여줄 정규 원문(마스킹 후) 기준이다.
     * 그래서 마스킹 전후의 대응표를 함께 남겨 근거를 정확히 옮긴다.
     * 원문이 응답에서 빠져도(적응형 포맷) 정규 원문은 따로 계산한다.
     */
    const unmaskedStdout = execStdoutRaw;
    let   maskRanges: readonly MaskedRange[] = [];
    const maskingOn = this.config.guard.secrets?.output_redaction_enabled === true;
    let   canonicalStdout = execStdoutRaw;
    let   canonicalStderr = execStderrRaw;
    if (maskingOn) {
      const patterns  = validatePatterns(resolveRedactPatterns(this.config));
      const masked    = maskWithRanges(unmaskedStdout, patterns);
      const maskedErr = maskWithRanges(execStderrRaw, patterns);
      maskRanges      = masked.ranges;
      canonicalStdout = masked.text;
      canonicalStderr = maskedErr.text;
      enriched = {
        ...enriched,
        stdout:  { ...enriched.stdout, raw: masked.text },
        stderr:  { ...enriched.stderr, raw: maskedErr.text },
      };
    }
    timer?.markEnd("redact");

    if (wantReview) {
      const review = this.attachReview(enriched, {
        cmd, args, cwd,
        resultId:        mintResultId(),
        parsed,          final,
        native,
        truncated:       enriched.truncated === true,
        silentEmpty:     Array.isArray(enriched.stdout.parse_error) ? false : parseError?.reason === "unrecognized_output",
        representation:  representationFailure ? false : true,
        compactApplied,
        evidenceReason,
        rawEvidence,
        unmaskedStdout,
        canonicalStdout,
        canonicalStderr,
        maskRanges,
        wantRetain,
        projection,
        context: opts?.context,
      });
      enriched = { ...enriched, review };
    }

    if (timer) {
      enriched = { ...enriched, telemetry: timer.toField() };
    }

    /**
     * 예산 적용은 표면(누락 내역·진행 정보)까지 붙인 뒤 최종 크기로 확인한다.
     * 리댁션과 review 가 끝난 뒤에 한다 — 사용자에게 나가는 payload 에 대한 약속이어야 한다.
     */
    if (opts?.budget) {
      const outcome = this.applyRunBudget(enriched, opts.budget, {
        cmd, args, cwd, maskRanges,
        parsed, projection, native,
        resultId: wantReview ? enriched.review?.result_id : undefined,
      });
      /**
       * 예산으로 줄인 결과를 그대로 응답에 실어야 한다.
       * 표면(예산·누락 내역·진행 정보)만 붙이고 본문을 그대로 두면 예산이 거짓말이 된다.
       */
      const { shrunkParsed, ...surface } = outcome;
      enriched = {
        ...enriched,
        ...surface,
        stdout: { ...enriched.stdout, parsed: shrunkParsed },
      };
    }

    return enriched as ResponseEnvelope;
  }

  /**
   * 이미 얻은 결과를 예산 안에 넣고 표면에 예산·누락 내역을 실는다.
   * 실행시간이나 수집량을 줄이지 않는다 — 어디까지 내보낼지만 정한다.
   */
  private applyRunBudget(
    envelope: ResponseEnvelope,
    budget: NonNullable<RunOptions["budget"]>,
    ctx: {
      cmd: string; args: string[]; cwd: string; maskRanges: readonly MaskedRange[];
      parsed: unknown; projection: ReturnType<typeof parseProjection> | undefined;
      native: boolean; resultId?: string;
    },
  ): { budget: unknown; omission: unknown; shrunkParsed: unknown; continuation?: Continuation } {
    const tokenizer = validateTokenizer(budget.tokenizer);
    if (!tokenizer.ok) {
      return {
        budget: {
          requested: { max_tokens: budget.max_tokens, tokenizer: budget.tokenizer ?? "parism/approx" },
          measured_tokens: 0, tokenizer_id: "", tokenizer_version: "",
          budget_met: false, tokenizer_exact: false, tokenizer_scope: "", error: tokenizer.message,
        },
        omission: [{ stage: "budget", reason: tokenizer.message }],
        shrunkParsed: envelope.stdout.parsed,
      };
    }

    const shape      = this.registry.contractFor(ctx.cmd, ctx.args);
    const identity   = shape?.rowFields ?? [];
    const parsed     = (envelope.stdout.parsed ?? ctx.parsed) as unknown;
    const value      = findRowArray(parsed) === null ? parsed : parsed;
    const silentEmpty = envelope.failure?.reason === "unrecognized_output";
    const parseFailed = envelope.failure?.kind === "parse" && envelope.failure.reason === "parser_not_found";

    const outcome = applyBudget({
      value,
      budget: { ...budget, tokenizer: tokenizer.id },
      identityFields: [...identity],
      resultId: ctx.resultId ?? "unretained",
      binding: {
        content_hash:   hashContent(envelope.stdout.raw),
        schema_version: ENVELOPE_SCHEMA_VERSION,
        policy:         JSON.stringify({
          args: ctx.args, cwd: ctx.cwd,
          where: ctx.projection?.ok ? ctx.projection.options.where ?? null : null,
          sort: ctx.projection?.ok ? ctx.projection.options.sort_by ?? null : null,
          array: ctx.projection?.ok ? ctx.projection.options.array ?? null : null,
          required: budget.required_fields ?? [],
        }),
      },
      captureTruncated:  envelope.truncated === true,
      silentEmpty,
      parseFailed,
      privacyApplied:    ctx.maskRanges.length > 0,
      projectionOmitted: 0,
      /**
       * '후보 값을 넣은 실제 응답' 전체를 재야 한다.
       * 값만 재면 표면이 빠져 실제 응답이 상한을 넘는데도 budget_met 이 참이 된다.
       */
      measure: (candidate, surface) => countJsonTokens(
        { ...envelope, budget: budgetReportPlaceholder(budget.max_tokens, tokenizer.id), ...surface,
          stdout: { ...envelope.stdout, parsed: candidate } },
        tokenizer.id,
      ),
    });

    /**
     * 이어 읽기는 재실행 없이 같은 결과에서 이어 가야 한다.
     * 원본 행 전체를 이 세션에 담아 두고, cursor 에는 진행 규칙과 오프셋만 싣는다.
     */
    if (outcome.continuation && ctx.resultId) {
      const found = findRowArray(parsed);
      if (found) {
        this.pages.set(ctx.resultId, {
          rows:    found.rows,
          binding: {
            result_id: ctx.resultId,
            content_hash:   hashContent(envelope.stdout.raw),
            schema_version: ENVELOPE_SCHEMA_VERSION,
            policy:         outcome.continuation ? "" : "",
          },
        });
      }
    }

    /**
     * ## 최종 상한 검증 — 계획서 M2 "최종 상한 검증"
     *
     * 예산을 적용할 때 재는 것은 **본문 + 표면**(누락 내역·진행 정보) 까지다.
     * 그런데 **예산 보고(`budget`)와 누락 목록(`omission`) 은 그 뒤에 붙는다.**
     * 그러면 소비자가 실제로 받는 응답이 재었던 것보다 커진다.
     *
     * 실측: `max_tokens: 1400` 요청 → `measured_tokens: 1330`, `budget_met: true`
     * → **실제 전달 응답 1,939 토큰. 상한의 138%다.**
     * `budget_met: true` 는 소비자가 지불하는 비용에 대해 참이 아니었고,
     * SPECIFICATION 의 정의("최종 payload 를 실제로 센 수")와 어긋났다.
     *
     * 보고가 자기 크기를 담는 자기 참조 필드(`measured_tokens`)를 가지므로 한 번의 측정으로는
     * 닫히지 않는다. 그래서 **확인 단계에서 실제 응답을 한 번 더 재고**, 아직 넘으면 넘은 만큼
     * 상한을 낮춰 **한 번만** 다시 적용한다.
     *
     * **한 번만**인 이유: 줄일 때마다 누락 항목이 자라 그만큼 다시 커진다. 줄이는 값과
     * 자라는 값이 싸우다 끝내 상한을 못 맞췄다(실측: 5,000 상한을 3회 시도 후에도 5,340).
     * 그래도 못 맞추면 **거짓으로 참이라 하지 않고** `budget_met: false` 와 명시적 누락 항목으로
     * 알린다. **못 맞추는 것보다 아무 값도 못 받는 쪽이 나쁘다** — 그래서 줄이지 않은 쪽을
     * 그대로 둔다.
     */
    const measureDelivered = (o: typeof outcome): number =>
      countJsonTokens(JSON.stringify({
        ...envelope,
        budget: o.report,
        omission: o.omissions,
        ...(o.continuation && { continuation: o.continuation }),
        stdout: { ...envelope.stdout, parsed: o.value },
      }), tokenizer.id);

    const applyWith = (maxTokens: number) => applyBudget({
      value, budget: { ...budget, max_tokens: maxTokens, tokenizer: tokenizer.id },
      identityFields: [...identity],
      resultId: ctx.resultId ?? "unretained",
      binding: {
        content_hash:   hashContent(envelope.stdout.raw),
        schema_version: ENVELOPE_SCHEMA_VERSION,
        policy: JSON.stringify({
          args: ctx.args, cwd: ctx.cwd,
          where: ctx.projection?.ok ? ctx.projection.options.where ?? null : null,
          sort: ctx.projection?.ok ? ctx.projection.options.sort_by ?? null : null,
          array: ctx.projection?.ok ? ctx.projection.options.array ?? null : null,
          required: budget.required_fields ?? [],
        }),
      },
      captureTruncated:  envelope.truncated === true,
      silentEmpty,
      parseFailed,
      privacyApplied:    ctx.maskRanges.length > 0,
      projectionOmitted: 0,
      measure: (candidate, surface) => countJsonTokens(
        { ...envelope, ...surface, stdout: { ...envelope.stdout, parsed: candidate } },
        tokenizer.id,
      ),
    });

    /**
     * 넘은 만큼만큼 상한을 낮춰 다시 적용한다.
     *
     * **맞으면 줄인 쪽을 쓴다. 안 맞으면 줄이지 않은 쪽을 그대로 둔다.**
     * 상한을 맞�다는 이유로 행을 0개까지 지우면 값이 사라지는 방향으로 나아간다 —
     * 상한에 못 미치는 것과 아무 값도 못 받는 것 중 어느 쪽이 나은지 자명하다.
     * 그래서 **들어온 시점에서 멈추고, 정직하게 '못 맞췄다' 고 말한다.**
     */
    const original = outcome;
    let   final    = original;
    let   delivered = measureDelivered(final);
    /**
     * 위에서 **검색 단계가 이미 보고 비용을 포함해 쟀으므로** 여기서는 한 번 확인하면 된다.
     * 이전처럼 반복해서 행을 줄이면, 줄일 때마다 누락 항목이 자라 그만큼 다시 커진다 —
     * 줄어드는 값과 자라는 값이 싸우다 끝내 상한을 못 맞춘다.
     * (실측: 5,000 상한을 3회 시도하고도 못 맞췄다.)
     */
    if (delivered > budget.max_tokens) {
      const tighter = budget.max_tokens - (delivered - budget.max_tokens);
      if (tighter > 0) {
        const next = applyWith(tighter);
        const size = measureDelivered(next);
        if (size <= budget.max_tokens) { final = next; delivered = size; }
      }
    }

    if (delivered > budget.max_tokens) {
      /**
       * **알림 항목부터 붙인 뒤에 다시 잰다.**
       *
       * 순서가 중요했다. 알림을 붙인 **다음에** 재야 그 알림이 차지하는 크기까지
       * `measured_tokens` 에 들어간다. 알림을 붙이고 이전 수치를 적으면
       * '최종 payload 를 실제로 센 수' 라는 SPEC 정의와 어긋난다(실측: 70토큰 차이).
       */
      const notice = {
        stage: "budget",
        reason: `the response does not fit the ${budget.max_tokens} token cap even after trimming rows: the envelope and this report alone cost more than the cap`,
      };
      const omissions = [...final.omissions, notice];
      const real = countJsonTokens(JSON.stringify({
        ...envelope,
        budget: { ...final.report, measured_tokens: 0, budget_met: false },
        omission: omissions,
        ...(final.continuation && { continuation: final.continuation }),
        stdout: { ...envelope.stdout, parsed: final.value },
      }), tokenizer.id);
      return {
        budget: { ...final.report, measured_tokens: real, budget_met: false },
        omission: omissions,
        shrunkParsed: final.value,
        ...(final.continuation && { continuation: final.continuation }),
      };
    }

    return {
      /** SPEC 의 정의대로 — 보고와 누락 목록까지 붙인 **최종 응답**의 토큰 수를 실린다 */
      budget:        { ...final.report, measured_tokens: delivered },
      omission:      final.omissions,
      shrunkParsed:  final.value,
      ...(final.continuation && { continuation: final.continuation }),
    };
  }

  /**
   * 저장된 결과의 다음 페이지를 재실행 없이 돌려준다.
   * 이미 만료·퇴출됐거나 진행 규칙이 어긋나면 그 사실을 알린다 — 임의 오프셋을 믿지 않는다.
   */
  fetchResult(
    resultId: string, cursor: string, budget?: { max_tokens: number; tokenizer?: string },
  ): FetchResult {
    const decoded = decodeCursor(cursor);
    if (!decoded) {
      return { ok: false, reason: "cursor_invalid", message: "cursor is not a valid continuation token" };
    }
    if (decoded.binding.result_id !== resultId) {
      return { ok: false, reason: "cursor_mismatch", message: "cursor belongs to a different result" };
    }
    const page = this.pages.get(resultId);
    if (!page) {
      const lookup = this.results.get(resultId);
      if (!lookup.found) {
        /**
         * 사유를 그대로 돌려준다. '처음부터 보관하지 않았다'(not_retained)와
         * '이 세션이 모르는 id'(unknown_id)는 원인이 다르다 — 둘을 합치면 무엇을 해야 하는지 알 수 없다.
         */
        return { ok: false, reason: lookup.reason, message: lookup.message };
      }
      return { ok: false, reason: "no_continuation", message: "this result was returned in one page; there is nothing to continue" };
    }

    const rows = page.rows;
    const start = decoded.offset;
    const head = budget ? validateTokenizer(budget.tokenizer) : { ok: true as const, id: "parism/approx" as const };
    if (!head.ok) return { ok: false, reason: "tokenizer_unsupported", message: head.message };

    let   taken  = rows.length - start;
    let   value: unknown = replaceRows({ entries: rows.slice(start) }, "entries", rows.slice(start));
    if (budget) {
      const outcome = applyBudget({
        value, budget: { ...budget, tokenizer: head.id }, identityFields: [],
        resultId, binding: page.binding, captureTruncated: false, silentEmpty: false,
        parseFailed: false, privacyApplied: false, projectionOmitted: 0,
        measure: (candidate, surface) => countJsonTokens(
          { result_id: resultId, offset: start, total: rows.length, ...surface, value: candidate },
          head.id,
        ),
      });
      value  = outcome.value;
      taken  = findRowArray(value)?.rows.length ?? taken;
    }

    const nextOffset = start + taken;
    const hasMore    = nextOffset < rows.length;
    return {
      ok: true, result_id: resultId, offset: start, returned: taken,
      total: rows.length,
      value,
      ...(hasMore && { continuation: { result_id: resultId, cursor: makeCursor(page.binding, nextOffset), rows_left: rows.length - nextOffset, total: rows.length } }),
    };
  }

  /**
   * 결과의 재검토 정보를 붙이고, 보관 요청이 있으면 세션에 담아 둔다.
   * 재검토 정보는 기존 봉투 필드의 뜻을 바꾸지 않는다.
   */
  private attachReview(
    envelope: ResponseEnvelope,
    input: {
      cmd: string; args: string[]; cwd: string; resultId: string; context?: UserContext;
      parsed: unknown; final: unknown; native: boolean; truncated: boolean;
      silentEmpty: boolean; representation: boolean; evidenceReason?: string; compactApplied: boolean;
      rawEvidence: RawEvidence; unmaskedStdout: string;
      canonicalStdout: string; canonicalStderr: string;
      maskRanges: readonly MaskedRange[];
      wantRetain: boolean; projection: ReturnType<typeof parseProjection> | undefined;
    },
  ): ReviewField {
    const warnings: string[] = [];
    if (input.truncated) {
      warnings.push("output exceeded max_output_bytes: evidence covers the retained prefix only");
    }
    if (input.evidenceReason === "native_json_document") {
      warnings.push("native JSON document: evidence points at the whole output, not a field span");
    }
    if (input.evidenceReason === "unsupported_format") {
      warnings.push("argument format is not contract-checked: no field evidence was produced");
    }
    if (input.compactApplied) {
      warnings.push("compact format changed the result shape: field pointers no longer resolve, so evidence was not produced");
    }
    /**
     * 투영이 행의 순서나 자리를 바꾸면 원래 포인터가结果的 행을 가리키지 않는다.
     * 근거를 지어내지 않고 '알 수 없음'으로 남긴다.
     */
    const reorderRequested =
      input.projection?.ok === true &&
      (input.projection.options.where !== undefined ||
       input.projection.options.sort_by !== undefined ||
       (input.projection.options.limit ?? 0) > 0 ||
       input.projection.options.array !== undefined);
    if (reorderRequested) {
      warnings.push("projection reordered or filtered rows: field evidence was dropped rather than guessed");
    }
    if (Object.keys(input.rawEvidence).length === 0) {
      warnings.push("this parser produces no field evidence yet; only the whole-output evidence is available");
    }

    const review = buildReview(
      {
        cmd:                input.cmd,
        parserId:           input.native ? "native_json" : this.registry.hasParser(input.cmd) ? input.cmd : "none",
        native:             input.native,
        truncated:          input.truncated,
        silentEmpty:        input.silentEmpty,
        parsedMissing:      input.parsed == null,
        representationLossless: input.representation,
        masked:             input.maskRanges.length > 0,
        canonicalStdout:    input.canonicalStdout,
        canonicalStderr:    input.canonicalStderr,
        schemaVersion:      PACKAGE_VERSION,
        warnings,
      },
      input.resultId,
    );

    if (!input.wantRetain) {
      /**
       * result_id 는 review 에 실렸으므로 사용자가 이 id 로 explain_result 를 부를 수 있다.
       * '처음부터 보관하지 않았다'는 사실을 남겨야 조회 시 그 사실로 거절한다.
       * 남기지 않으면 모르는 id 와 구분되지 않아 '어디에 갔나' 알 수 없다.
       */
      this.results.markNotRetained(input.resultId);
      return review;
    }

    const evidence = this.buildEvidence(input);
    const stored: StoredResult = {
      resultId:  input.resultId,
      createdAt: Date.now(),
      /**
       * 정규 원문은 마스킹 후 기준이다. 응답에서 원문이 빠졌어도(적응형 포맷) 보관본은 실출력을 담는다 —
       * 근거 구간이 가리키는 대상이 사라지지 않게 하는 것이 목적이다.
       */
      stdout:    input.canonicalStdout,
      stderr:    input.canonicalStderr,
      parsed:    input.final,
      evidence,
      review,
      /**
       * **근거도 바이트에 넣는다.**
       *
       * 근거 맵은 값 자체를 함께 담는다(근거가 그 값을 증명해야 하므로).
       * 그래서 본문만큼이나, 대개는 더 크게 든다. 예전에는 본문과 원문만 세어
       * 실제 보관 크기의 2.58배를 과소 보고했다(실측) — 문서에 적힌 한도(결과당 2MiB)가
       * 실제로는 그 2.58배까지 들어가는 상태로 집행되고 있었다.
       */
      bytes:     storedBytesOf(input, evidence, this.results.perResultLimit),
      cmd:       input.cmd,
      args:      input.args,
      cwd:       input.cwd,
      fingerprint: buildFingerprint({
        cmd:    input.cmd,
        args:   input.args,
        cwd:    input.cwd,
        policy: this.config.guard,
        review,
        context: input.context,
        env:    process.env,
      }),
    };
    const put = this.results.put(stored);
    if (!put.retained) {
      return { ...review, retained: false, warnings: [...review.warnings, put.reason ?? "result was not retained"] };
    }
    return { ...review, retained: true };
  }

  /**
   * 파서가 준 문자열 위치를 마스킹된 정규 원문의 바이트 구간으로 바꾸고, 그 구간이 정말 그 값을
   * 담는지 확인한다. 확인되지 않으면 근거가 아니라 "근거 없음"으로 남긴다.
   */
  private buildEvidence(
    input: {
      rawEvidence: RawEvidence; unmaskedStdout: string; canonicalStdout: string;
      maskRanges: readonly MaskedRange[];
      final: unknown; projection: ReturnType<typeof parseProjection> | undefined;
    },
  ): Record<string, FieldEvidence[]> {
    const reorders =
      input.projection?.ok === true &&
      (input.projection.options.where !== undefined ||
       input.projection.options.sort_by !== undefined ||
       (input.projection.options.limit ?? 0) > 0 ||
       input.projection.options.array !== undefined);
    if (reorders || Object.keys(input.rawEvidence).length === 0) return {};

    const unmaskedIndex = buildLineIndex(input.unmaskedStdout);
    const canonical    = input.canonicalStdout;
    const spans        = evidenceToByteSpans(
      input.rawEvidence, unmaskedIndex, canonical, input.maskRanges,
    );
    const out: Record<string, FieldEvidence[]> = {};

    for (const [pointer, list] of Object.entries(spans)) {
      const value = resolvePointer(input.final, pointer);
      if (value === undefined) continue;
      const check = verifySpans(canonical, list, value);
      const transform = list.find(s => s.transform)?.transform;
      if (check.ok) {
        out[pointer] = [{
          value:        value,
          source_kind:  transform === undefined ? "verbatim" : "derived",
          source_spans: list,
          ...(transform && { transform }),
          masked:       input.maskRanges.length > 0,
        }];
      } else {
        out[pointer] = [{
          value, source_kind: "none", source_spans: [], masked: false, reason: check.reason,
        }];
      }
    }
    return out;
  }

  /**
   * 이미 존재하는 두 결과의 의미 diff 를 낸다.
   *
   * read 단계다 — 새 명령을 실행하지 않고, 원격에 접속하지 않고, 감시 루프를 만들지 않는다.
   * 비교가 성립하지 않으면 그 이유를 함께 돌려준다. 아무것도 비교 안 하고 '변화 없음'이라고
   * 말하지 않는다.
   */
  compare(baseId: string, currentId: string, options: CompareOptions & { strict?: boolean } = {}): CompareResult {
    const base    = this.sideFor(baseId);
    const current = this.sideFor(currentId);
    if (base === null || current === null) {
      const missing = base === null ? baseId : currentId;
      return {
        ok: false, comparable: false,
        refusals: { comparable: false, compatibility: "unknown", reasons: [], ignored: [] },
        domain: "unknown", added: [], removed: [], changed: [], unchanged_count: 0,
        ignored_fields: options.ignore_fields ?? [],
        partial: { base_incomplete: false, current_incomplete: false, withheld_reasons: [] },
        key_conflicts: [],
        refusal_reason: "result_not_retained",
        message: `result '${missing}' is not retained in this session; comparison never re-executes a command`,
      };
    }
    return compareResults({
      base, current,
      options: { ...(options.keys && { keys: options.keys }), ...(options.ignore_fields && { ignore_fields: options.ignore_fields }) },
      strict:  options.strict === true,
    });
  }

  /** 저장된 결과를 비교 한 쪽 재료로 바꾼다 */
  private sideFor(resultId: string): CompareSide | null {
    const lookup = this.results.get(resultId);
    if (!lookup.found) return null;
    const stored = lookup.result;
    /** 지문 없이 보관된 결과는 비교 대상이 아니다. 꾸미지 말고 거절한다. */
    if (!stored.fingerprint) return null;
    const reasons: string[] = [];
    if (stored.review.source_complete === false) reasons.push("the result was cut at the capture limit");
    if (stored.review.parse_complete === false) reasons.push("the parser recognized nothing for part of the output");
    if (stored.review.representation_lossless === false) reasons.push("a display conversion lost values");
    const fingerprint = stored.fingerprint;
    return {
      resultId,
      fingerprint,
      rows: (stored.parsed ?? {}) as unknown[],
      incomplete: reasons.length > 0,
      incompleteReasons: reasons,
      review: {
        source_complete: stored.review.source_complete,
        parse_complete:  stored.review.parse_complete,
      },
    };
  }

  /**
   * 보관된 결과의 특정 값을 다시 본다. 재실행하지 않는다.
   * 보관되지 않았거나 만료되었으면 그 사실을 알린다 — 조회失敗를 성공처럼 감추지 않는다.
   */
  explainResult(resultId: string, pointer: string): ExplainResult {
    const lookup = this.results.get(resultId);
    if (!lookup.found) {
      return { ok: false, result_id: resultId, reason: lookup.reason, message: lookup.message };
    }
    const stored = lookup.result;
    if (pointer === "" || pointer === "#") {
      return {
        ok: true, result_id: resultId, pointer: "", value: stored.parsed,
        source_kind: "none", source_spans: [], age_ms: lookup.age_ms,
        review: stored.review, reason: "whole result: ask for a field pointer to see where a value came from",
      };
    }
    const value = resolvePointer(stored.parsed, pointer);
    if (value === undefined) {
      return {
        ok: false, result_id: resultId, pointer, reason: "unknown_pointer",
        message: `pointer '${pointer}' does not resolve in this result`,
      };
    }
    const chain = this.evidenceChain(stored, pointer);
    if (chain.length === 0) {
      return {
        ok: true, result_id: resultId, pointer, value,
        source_kind: "none", source_spans: [], age_ms: lookup.age_ms, review: stored.review,
        reason: "no field evidence was recorded for this pointer",
      };
    }
    const last    = chain[chain.length - 1]!;
    const sources = [...new Set(last.source_spans.map(s => s.source))];
    const text    = sources.includes("stderr") ? stored.stderr : stored.stdout;
    return {
      ok: true, result_id: resultId, pointer, value,
      source_kind: last.source_kind,
      source_spans: last.source_spans,
      ...(last.transform && { transform: last.transform }),
      masked: last.masked,
      age_ms: lookup.age_ms,
      review: stored.review,
      /** 사람이 확인할 수 있게 마스킹된 정규 원문의 해당 구간 텍스트를 함께 준다 */
      quoted: last.source_spans.map(span => sliceByBytes(text, span.start, span.end)),
    };
  }

  /**
   * 근거 표에서 포인터에 해당하는 항목을 찾는다.
   * 근거는 결과 구조를 바꾼 경우 지어내지 않고 비워 두므로, 정확한 키 일치로 충분하다.
   */
  private evidenceChain(stored: StoredResult, pointer: string): FieldEvidence[] {
    const key = pointer.startsWith("#") ? pointer.slice(1) : pointer;
    return stored.evidence[key] ?? [];
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
