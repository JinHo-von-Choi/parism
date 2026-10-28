/**
 * ParismEngine — 라이브러리 모드 진입점.
 * MCP 서버 없이 Node.js 소비자가 Parism 파이프라인을 직접 사용할 수 있도록 한다.
 *
 * 작성자: 최진호
 * 작성일: 2026-04-15
 */

import { realpathSync }                                                             from "node:fs";
import path                                                                         from "node:path";
import { loadConfig, loadConfigMultiLayer }                                         from "../config/loader.js";
import type { PrismConfig }                                                         from "../config/loader.js";
import { createRegistry }                                                           from "../parsers/index.js";
import type { ParserRegistry }                                                      from "../parsers/registry.js";
import type { OutputFormat }                                                        from "../parsers/registry.js";
import type { FailureInfo, ParseErrorField, ResponseEnvelope }                      from "../types/envelope.js";
import { execute, truncateUtf8Lines }                                               from "../engine/executor.js";
import { checkGuard, GuardError }                                                   from "../engine/guard.js";
import { buildAvailabilityFailure, probeAll }                                   from "../engine/availability.js";
import { buildExecArgs, resolvePolicies }                                           from "../engine/policy.js";
import { PageCache }                                                                from "../engine/page-cache.js";
import { paginateLines }                                                            from "../engine/paginator.js";
import { Semaphore }                                                                from "../engine/semaphore.js";
import { redact, validatePatterns }                                                 from "../engine/redactor.js";
import type { RegexFallback }                                                        from "../engine/regex-engine.js";
import { toCompact }                                                                from "../parsers/compact.js";
import { loadExternalParsers, externalParserOptions }                               from "../cli/auto-loader.js";
import { parismHome }                                                               from "../cli/paths.js";
import { OutcomeStats, PipelineTimer, type CommandOutcomeCounts }                  from "../engine/telemetry.js";
import { describeCommand, type CommandDescription, type CommandDescriptionFailure } from "./capabilities.js";
import { applyProjection, hasProjection, parseProjection,
         type ProjectionSummary }                                                   from "../engine/projection.js";
import { PACKAGE_VERSION }                                                          from "../version.js";
import { countJsonTokens }                                                          from "../engine/budget/tokenizer.js";
import { applyBudget, decodeCursor, makeCursor, validateTokenizer, budgetTooSmall,
         findRowArray, replaceRows, MINIMUM_ENVELOPE_TOKENS }                    from "../engine/budget/index.js";
import { compareResults, type CompareOptions, type CompareResult, type CompareSide } from "../engine/compare/index.js";
import { ResultStore, resolvePointer, type StoredResult }                           from "../engine/result-store.js";
import { type FieldEvidence, type RawEvidence }                                      from "../engine/evidence.js";
import { mintResultId, sliceByBytes }                                               from "../engine/review.js";
import { maskWithRanges, type MaskedRange }                                          from "../engine/mask-map.js";

/**
 * 분리된 모듈들.
 *
 * `envelope.ts`  — 봉투를 만드는 순수 함수와 공개 타입
 * `review.ts`    — 재검토(review)와 근거(evidence) 조립
 * `run-budget.ts`— 토큰 예산 적용
 *
 * 이 세 모듈은 `ParismEngine` 을 모른다. 엔진이 이들을 부르는 방향으로만 의존한다.
 */
import {
  buildGuardErrorEnvelope,
  buildRejectedEnvelope,
  concurrencyLimit,
  projectionInput,
  resolveRedactPatterns,
  DEFAULT_MAX_PAGE_SIZE,
  type ExplainResult,
  type FetchResult,
  type RunOptions,
  type RunPagedOptions,
} from "./envelope.js";
import { attachReview }                                                    from "./review.js";
import { applyRunBudget, type PageStore }                                  from "./run-budget.js";

/**
 * 공개 타입을 이 자리에서 다시 내보낸다.
 *
 * 이 파일은 패키지의 `@nerdvana/parism/engine` 서브패스 export 다.
 * 타입의 **실체**는 다른 모듈로 옮겼지만, **import 경로**는 바꾸지 않는다 —
 * 소비자가 `@nerdvana/parism/engine` 에서 꺼내던 이름이 그대로여야 한다.
 */
export type {
  ExecOptions,
  ExplainResult,
  FetchResult,
  RunOptions,
  RunPagedOptions,
} from "./envelope.js";

const PAGE_CACHE_TTL_MS      = 30_000;
const PAGE_CACHE_MAX_ENTRIES = 16;
const PAGE_CACHE_MAX_BYTES   = 32 * 1024 * 1024;

export class ParismEngine {
  private readonly pageCache = new PageCache(PAGE_CACHE_TTL_MS, PAGE_CACHE_MAX_ENTRIES, PAGE_CACHE_MAX_BYTES);
  /** 자식 프로세스 동시 실행 상한. 넘는 요청은 자리가 날 때까지 대기한다. */
  private readonly execSlots: Semaphore;
  /** 텔레메트리를 켰을 때만 있는 명령별 결과 카운터 */
  private readonly stats:     OutcomeStats | null;
  /** retain=true 로 요청한 결과를 보관해 explain_result 로 다시 본다. 메모리에만 있고 디스크에 남지 않는다. */
  private readonly results:   ResultStore;
  /** 예산 안에 잘라 낸 결과의 원본 행을 보관해 이어 읽기가 재실행 없이 되게 한다. */
  private readonly pages:     PageStore = new Map();

  constructor(
    private readonly config:   PrismConfig,
    private readonly registry: ParserRegistry,
  ) {
    this.execSlots = new Semaphore(concurrencyLimit(config.guard.max_concurrency));
    this.stats     = config.telemetry?.enabled === true ? new OutcomeStats(config.guard.allowed_commands) : null;
    this.results   = new ResultStore();
  }

  /**
   * 실행 실패가 "이 호스트에 명령이 없다" 일 때 설치 정보를 덧붙인다.
   *
   * ENOENT 만 대상으로 한다.
   * - EACCES(실행 권한 없음)는 설치로 해결되지 않는다.
   * - spawn_failed 가 아닌 reason 은 스폰 실패가 아니다.
   *
   * 기존 `failure.kind` 와 `failure.reason` 은 그대로 둔다(CON-001, CON-002).
   * 새 정보는 `failure.availability` 라는 **추가 필드**로만 들어간다.
   */
  private attachAvailability(envelope: ResponseEnvelope, cmd: string, args: readonly string[], cwd: string): ResponseEnvelope {
    if (envelope.failure?.reason !== "spawn_failed") return envelope;
    if (envelope.failure.errorCode !== "ENOENT") return envelope;
    /** 대체 명령도 원래 명령과 같은 가드를 통과해야 안내한다. 실행하면 거절될 명령을 제안하지 않는다. */
    const permits = (altCmd: string, altArgs: readonly string[]): boolean => {
      try {
        checkGuard(altCmd, [...altArgs], cwd, this.config);
        return true;
      } catch {
        return false;
      }
    };
    const availability = buildAvailabilityFailure(cmd, args, permits);
    if (!availability) return envelope;
    return { ...envelope, failure: { ...envelope.failure, availability } };
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
    const envelope = this.attachAvailability({ ...executed, args }, cmd, args, cwd);
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

    const rawOmitted   = dropRaw && final !== null;
    const stdout       = rawOmitted
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
    /**
     * 정규식 엔진이 TypeScript 로 되돌아간 사실. 결과에 남긴다 —
     * 조용히 바뀌면 "무엇이 왜 바뀌었는지" 를 나중에 알 수 없다.
     */
    const regexFallbacks: RegexFallback[] = [];
    const noteFallback = (info: RegexFallback) => { regexFallbacks.push(info); };
    const maskingOn = this.config.guard.secrets?.output_redaction_enabled === true;
    let   canonicalStdout = execStdoutRaw;
    let   canonicalStderr = execStderrRaw;
    if (maskingOn) {
      const patterns  = validatePatterns(resolveRedactPatterns(this.config));
      const masked    = await maskWithRanges(unmaskedStdout, patterns, { onFallback: noteFallback });
      const maskedErr = await maskWithRanges(execStderrRaw, patterns, { onFallback: noteFallback });
      maskRanges      = masked.ranges;
      canonicalStdout = masked.text;
      canonicalStderr = maskedErr.text;
      /**
       * 형식 때문에 응답에서 뺀 원문은 마스킹한 값으로 다시 채우지 않는다.
       * 실패 메시지에는 비정상 종료 시 stderr 와 인자가 그대로 들어 있으므로 함께 마스킹한다.
       */
      const failure = enriched.failure && {
        ...enriched.failure,
        message: await redact(enriched.failure.message, patterns, { onFallback: noteFallback }),
      };
      enriched = {
        ...enriched,
        stdout:  rawOmitted ? enriched.stdout : { ...enriched.stdout, raw: masked.text },
        stderr:  { ...enriched.stderr, raw: maskedErr.text },
        ...(failure && { failure }),
      };
    }
    /**
     * 정규식 엔진이 TypeScript 로 되돌아간 사실을 결과에 남긴다.
     * 실패가 아니라 **메타데이터**다 — `failure` 가 아니라 결과에 붙는다.
     */
    if (regexFallbacks.length > 0) {
      enriched = { ...enriched, regex_engine: { used: "typescript", fallbacks: regexFallbacks } };
    }
    timer?.markEnd("redact");

    if (wantReview) {
      const review = attachReview(enriched, {
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
      }, { results: this.results, registry: this.registry, config: this.config });
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
      const outcome = applyRunBudget(enriched, opts.budget, {
        cmd, args, cwd, maskRanges,
        parsed, projection, native,
        /**
         * 기본 계약에는 review 식별자가 없다. 그래도 이어 읽기 cursor 를 내면
         * fetch_result 가 찾을 수 있는 식별자로 페이지를 보관해야 한다.
         */
        resultId: (wantReview ? enriched.review?.result_id : undefined) ?? mintResultId(),
      }, { registry: this.registry, pages: this.pages });
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
    /**
     * 허용 명령 전체의 설치 상태를 한 번에 조회한다.
     * 명령 하나씩 물어보면 PATH 를 여러 번 훑는다. 한 번에 훑고 60초 캐시를 쓴다.
     */
    const commandAvailability = Object.fromEntries(
      [...probeAll(guard.allowed_commands)].map(([cmd, result]) => [cmd, result.status]),
    );
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
      command_availability: commandAvailability,
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
      envelope  = this.attachAvailability({ ...executed, args }, cmd, args, cwd);
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
      /** 정규식 엔진이 TypeScript 로 되돌아간 사실. 결과에 남긴다. */
      const regexFallbacks: RegexFallback[] = [];
      const noteFallback = (info: RegexFallback) => { regexFallbacks.push(info); };
      const failure = enriched.failure && {
        ...enriched.failure,
        message: await redact(enriched.failure.message, patterns, { onFallback: noteFallback }),
      };
      enriched = {
        ...enriched,
        stdout:  { ...enriched.stdout, raw: await redact(enriched.stdout.raw, patterns, { onFallback: noteFallback }) },
        stderr:  { ...enriched.stderr, raw: await redact(enriched.stderr.raw, patterns, { onFallback: noteFallback }) },
        ...(failure && { failure }),
        ...(regexFallbacks.length > 0 && { regex_engine: { used: "typescript", fallbacks: regexFallbacks } }),
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
  /**
   * 허용 명령별 설치 상태. 키는 allowed_commands 와 같다.
   * "installed" 는 이 호스트에서 실행할 수 있다는 뜻이고, "missing" 은 PATH 에 없다는 뜻이다.
   */
  command_availability?: Record<string, "installed" | "missing" | "not_executable">;
  /** 텔레메트리를 켰을 때만 있는 명령별 결과 횟수. 프로세스 안에만 있고 재시작하면 비워진다. */
  stats?:             Record<string, CommandOutcomeCounts>;
}

/** dryRun() 반환 타입. */
export interface DryRunResult {
  would_pass: boolean;
  reason?:    string;
  message?:   string;
}
