/**
 * 응답 봉투를 만드는 **순수** 함수들.
 *
 * ## 왜 분리했나
 *
 * `facade/engine.ts` 는 한 번에 1,274줄이었다. 그 안에는 서로 성격이 다른 세 가지가
 * 뒤섞여 있었다 — 타입 정의, 순수 계산, 그리고 상태를 가진 클래스. 어느 하나를 고치려면
 * 1,274줄을 전부 읽어야 했다.
 *
 * 이 모듈은 그중 **상태가 없고, 다른 모듈에 의존하지 않는** 부분만 모은 것이다.
 * 클래스는 이 함수들을 불러 쓰고, 이 함수들은 클래스를 모른다.
 *
 * 이 방향을 뒤집지 않는다 — 여기서 `ParismEngine` 을 들여다보면 계층이 뒤집힌다.
 *
 * 작성자: 최진호
 * 작성일: 2026-10-22
 */

import type { PrismConfig }                                    from "../config/loader.js";
import type { GuardError }                                     from "../engine/guard.js";
import { DEFAULT_OUTPUT_REDACT_PATTERNS }                      from "../engine/redactor.js";
import { PROJECTION_SHAPE, type ProjectionOptions }            from "../engine/projection.js";
import type { Continuation }                                   from "../engine/budget/index.js";
import type { SourceSpan }                                     from "../engine/evidence.js";
import type { UserContext }                                    from "../engine/compare/fingerprint.js";
import type { FailureInfo, ResponseEnvelope, ReviewField }     from "../types/envelope.js";

// ── 타입 ──────────────────────────────────────────────────────────────────

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

// ── 상수 ──────────────────────────────────────────────────────────────────

/** 설정에 동시 실행 상한이 없을 때(이전 형식의 설정 객체) 쓰는 값 */
export const DEFAULT_MAX_CONCURRENCY = 4;

/** 설정에 page_size 상한이 없을 때(이전 형식의 설정 객체) 쓰는 값 */
export const DEFAULT_MAX_PAGE_SIZE = 1000;

// ── 순수 함수 ──────────────────────────────────────────────────────────────

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
export function budgetReportPlaceholder(maxTokens: number, tokenizerId: string): Record<string, unknown> {
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

/**
 * config에서 effective 리댁션 패턴을 결정한다.
 * - output_patterns가 undefined(미설정) → DEFAULT_OUTPUT_REDACT_PATTERNS 사용
 * - output_patterns가 [] (빈 배열 명시) → 빈 배열 사용 (사용자 의도적 비활성)
 * - output_patterns가 비어있지 않은 배열  → 해당 배열 사용 (defaults와 병합하지 않음)
 */
export function resolveRedactPatterns(config: PrismConfig): string[] {
  const patterns = config.guard.secrets?.output_patterns;
  if (patterns === undefined) return DEFAULT_OUTPUT_REDACT_PATTERNS;
  return patterns;
}

/**
 * 실행하지 않고 거부한 요청의 봉투. 메시지는 stderr.raw와 failure에 함께 둔다.
 */
export function buildRejectedEnvelope(
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

/**
 * Guard 차단 시 반환하는 에러 봉투를 생성한다.
 * 직렬화된 출력과의 하위 호환성을 위해 guard_error 필드를 유지한다.
 */
export function buildGuardErrorEnvelope(
  cmd: string, args: string[], cwd: string, err: GuardError,
): ResponseEnvelope {
  return buildRejectedEnvelope(cmd, args, cwd, { kind: "guard", reason: err.reason, message: err.message }, { reason: err.reason, message: err.message });
}

/** RunOptions에서 값이 있는 투영 인자만 모은다. */
export function projectionInput(opts: RunOptions | undefined): Record<string, unknown> {
  const input: Record<string, unknown> = {};
  if (!opts) return input;
  for (const key of Object.keys(PROJECTION_SHAPE) as (keyof ProjectionOptions)[]) {
    if (opts[key] !== undefined) input[key] = opts[key];
  }
  return input;
}

/**
 * 세마포어에 쓸 동시 실행 상한. 검증을 거치지 않은 설정 객체도 받으므로
 * 값이 없거나 유한한 수가 아니면 기본값을, 1 미만이면 1을 쓰고 소수는 버린다.
 */
export function concurrencyLimit(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return DEFAULT_MAX_CONCURRENCY;
  return Math.max(1, Math.floor(value));
}
