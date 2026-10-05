/**
 * 토큰 예산과 누락 내역.
 *
 * 핵심은 '예산 때문에 사라진 정보'와 '파서 오류 때문에 사라진 정보'를 섞지 않는 것이다.
 * 어느 단계에서 무엇이 빠졌는지 reasons 로 밝히고, 필요한 행은 재실행 없이 이어 읽을 수 있게 한다.
 *
 * 예산은 명령 실행시간이나 수집량을 줄이는 기능이 아니다. 이미 얻은 결과를 어디까지 내보낼지 정한다.
 *
 * 작성자: 최진호
 * 작성일: 2026-10-05
 */

import { isSupportedTokenizer, tokenizerInfo, type TokenizerId } from "./tokenizer.js";
import type { Completeness } from "../evidence.js";

/** 예산이 넘었을 때 처리 방식 */
export type OverflowMode = "page" | "error";

/** 무엇이 사라졌는지. 한 결과에 여러 원인이 함께 있을 수 있다. */
export type OmissionStage = "capture" | "parse" | "projection" | "budget" | "privacy";

export interface BudgetRequest {
  max_tokens:     number;
  /** 기본값 parism/approx. 지원하지 않는 이름이면 조용히 대체하지 않고 거절한다 */
  tokenizer?:     string;
  /** 모든 반환 행에서 반드시 남길 필드 */
  required_fields?: string[];
  overflow?:      OverflowMode;
}

export interface BudgetReport {
  requested:       { max_tokens: number; tokenizer: string };
  measured_tokens: number;
  tokenizer_id:    string;
  tokenizer_version: string;
  /** true 여야 정확한 budget_met 이다. 근사 토크나이저로 셌으면 false 다 */
  budget_met:      boolean;
  tokenizer_exact: boolean;
  /** 이 약속이 어디까지 성립하는지 */
  tokenizer_scope: string;
}

export interface Omission {
  stage:        OmissionStage;
  reason:       string;
  rows_total?:    number;
  rows_selected?: number;
  rows_returned?: number;
  rows_omitted?:  number;
  omitted_fields?: string[];
  /** 이 수만큼은 못 센다는 뜻(수집 상한에 걸려 전체 행을 모른다) */
  unknown_counts?: Record<string, number>;
  next_cursor?:  string | null;
}

export interface Continuation {
  result_id: string;
  cursor:    string;
  rows_left: number;
  total:     number;
}

/** 예산 적용 결과 */
export interface BudgetOutcome {
  /** 잘라 낸 뒤의 결과 */
  value:     unknown;
  report:    BudgetReport;
  omissions: Omission[];
  continuation?: Continuation;
}

/** 진행 규칙은 약속한 결과에 붙어 다닌다. 클라이언트가 임의로 조립한 규칙은 믿지 않는다. */
export interface CursorBinding {
  result_id:   string;
  content_hash: string;
  schema_version: string;
  /** 투영·정렬·필터가 바뀌면 이어 읽기가 무의미해진다 */
  policy:      string;
}

/** 진행 위치. 오프셋을 클라이언트가 정하지 않는다. */
export interface PageCursor {
  binding: CursorBinding;
  offset:  number;
}

function encodeCursor(cursor: PageCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

export function decodeCursor(raw: string): PageCursor | null {
  try {
    const parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) as PageCursor;
    if (typeof parsed?.offset !== "number" || !parsed.binding?.result_id) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function makeCursor(binding: CursorBinding, offset: number): string {
  return encodeCursor({ binding, offset });
}

/** 결과에서 행 배열을 찾아낸다. 없으면 예산을 줄일 대상이 없다. */
export function findRowArray(value: unknown): { key: string; rows: unknown[] } | null {
  if (Array.isArray(value)) return { key: "", rows: value };
  if (typeof value !== "object" || value === null) return null;
  for (const [key, inner] of Object.entries(value)) {
    if (Array.isArray(inner)) return { key, rows: inner };
  }
  return null;
}

/** 예산이 최소 봉투조차 못 담을 때 실수용으로 충분히 작은 수. */
export const MINIMUM_ENVELOPE_TOKENS = 1_200;

/**
 * 필요한 필드가 어떤 행에라도 없으면 실수다. 조용히 없애지 않고 명시적으로 밝힌다.
 * 모든 행이 보존한 필드가 아니라면 '어느 행이랑 맞춰야 하는가'부터 애매하므로 전체를 실패로 본다.
 */
export function findMissingRequired(
  rows: unknown[], required: string[], identityFields: string[],
): { missing: string[]; rowIndex: number } | null {
  if (required.length === 0) return null;
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (typeof row !== "object" || row === null) continue;
    const keys = new Set([...Object.keys(row as Record<string, unknown>), ...identityFields]);
    for (const field of required) {
      if (!keys.has(field)) return { missing: [field], rowIndex: i };
    }
  }
  return null;
}

/** 행에서 살릴 필드 목록. 필수 필드와 행 identity 를 반드시 남긴다. */
export function retainedFields(row: unknown, required: string[], identityFields: string[]): string[] {
  const keys = Object.keys((row ?? {}) as Record<string, unknown>);
  const keep = new Set<string>([...required, ...identityFields]);
  return keys.filter(k => keep.size === 0 || keep.has(k));
}

export interface ApplyBudgetInput {
  value:          unknown;
  budget:         BudgetRequest;
  /** 파서가 정의한 행 필드. identity 로도 쓴다 */
  identityFields: string[];
  resultId:       string;
  binding:        Omit<CursorBinding, "result_id">;
  /** 실행 단계에서 이미 잘렸는지. 전체 행 수를 모른다 */
  captureTruncated: boolean;
  /** 파서가 조용히 빈 결과를 냈는지 */
  silentEmpty:     boolean;
  /** 파싱 실패로 값이 없는지 */
  parseFailed:     boolean;
  /** 프라이버시 변환이 결과를 건드렸는지 */
  privacyApplied:  boolean;
  /** 명시적 투영으로 빠진 행이 있는지 */
  projectionOmitted: number;
  /**
   * 최종 payload 크기를 재는 방법. 엔진이 이긴다.
   * 값만 재면 표면(review, 실패, raw, 누락 내역)이 빠져 실제 응답이 상한을 넘고도 budget_met 이 참이 된다.
   * 그래서 '후보 값을 넣은 실제 응답' 전체를 재도록 바깥에 맡긴다.
   */
  measure:        (value: unknown, surface: Record<string, unknown>) => number;
}

/**
 * 결과를 예산 안에 넣는다.
 *
 * 순서는 고정이적이다: 필수 필드 검증 → 행 수를 줄이며 실제 직렬화로 매번 잰다 →
 * 표면(누락 내역·진행 정보)까지 붙인 뒤 최종 크기를 다시 확인한다.
 * 마지막 검사를 빠뜨리면 "본문만 예산 안에 들었다"고 잘못 말하게 된다.
 */
export function applyBudget(input: ApplyBudgetInput): BudgetOutcome {
  const tokenizer = (input.budget.tokenizer ?? "parism/approx") as TokenizerId;
  const mode: OverflowMode = input.budget.overflow ?? "page";
  const required = input.budget.required_fields ?? [];
  const omissions: Omission[] = [];

  const report: BudgetReport = {
    requested:         { max_tokens: input.budget.max_tokens, tokenizer },
    measured_tokens:   0,
    tokenizer_id:      tokenizerInfo(tokenizer).id,
    tokenizer_version: tokenizerInfo(tokenizer).version,
    budget_met:        false,
    tokenizer_exact:   tokenizerInfo(tokenizer).exact,
    tokenizer_scope:   tokenizerInfo(tokenizer).scope,
  };

  /** 표면(누락 내역·진행 정보)이 붙은 상태의 실제 크기를 잰다. */
  const measure = (candidate: unknown, surface: Record<string, unknown> = {}): number =>
    input.measure(candidate, surface);

  const found = findRowArray(input.value);
  if (!found) {
    /** 행 배열이 없으면 줄일 수 없다. 그 상태로 크기를 잰다. */
    report.measured_tokens = measure(input.value);
    report.budget_met = report.measured_tokens <= input.budget.max_tokens;
    return { value: input.value, report, omissions };
  }

  const missing = findMissingRequired(found.rows, required, input.identityFields);
  if (missing) {
    /** 필요한 필드가 없으면 성공 결과를 내보내지 않는다. 부분 성공은 조용한 손실이다. */
    omissions.push({
      stage:  "projection",
      reason: `required field '${missing.missing[0]}' is missing from row ${missing.rowIndex}`,
    });
    report.measured_tokens = measure(input.value);
    return { value: input.value, report, omissions };
  }

  const total = found.rows.length;
  let   kept  = found.rows;

  /** 살리는 필드를 좁히는 것은 필수 필드와 identity 를 건드리지 않는 한에서만 한다. */
  const narrow = (): void => {
    if (required.length === 0 && input.identityFields.length === 0) return;
    const first = kept[0];
    if (typeof first !== "object" || first === null) return;
    const all = Object.keys(first as Record<string, unknown>);
    const keep = retainedFields(first, required, input.identityFields);
    if (keep.length === all.length) return;
    kept = kept.map(row => {
      if (typeof row !== "object" || row === null) return row;
      const out: Record<string, unknown> = {};
      for (const key of keep) out[key] = (row as Record<string, unknown>)[key];
      return out;
    });
  };

  narrow();

  /**
   * 행 수를 줄이며 매번 '후보 값을 넣은 실제 응답' 크기로 잰다. 추정으로 맞추지 않는다.
   * 전부 들어가면 탐색이 전체 길이로 수렴하고, 하나도 못 들어가면 0 이 된다.
   */
  let lo = 0;
  let hi = kept.length;
  while (lo < hi) {
    const mid       = Math.ceil((lo + hi) / 2);
    const candidate = replaceRows(input.value, found.key, kept.slice(0, mid));
    if (measure(candidate) <= input.budget.max_tokens) lo = mid; else hi = mid - 1;
  }

  /**
   * 누락 내역과 진행 정보를 표면에 얹으면 크기가 더 늘어난다. 그래서 최종 재검증이 필요하다.
   * 늘어난 만큼 한 행씩 더 덜어 실제 payload 가 상한 안에 들어갈 때까지 확인한다.
   * 이 검사를 빠뜨리면 '본문만 예산 안에 들었다'고 잘못 말하게 된다.
   */
  const total_ = total;
  let   kept_  = kept;
  for (;;) {
    const hasMore  = kept_.length < total_;
    const progress: Record<string, unknown> = hasMore
      ? { continuation: { result_id: input.resultId, cursor: "", rows_left: total_ - kept_.length, total: total_ } }
      : {};
    const surface: Record<string, unknown> = {
      omission:      [...omissions, ...(hasMore ? [{ stage: "budget", reason: "" }] : [])],
      ...progress,
    };
    const sized = measure(replaceRows(input.value, found.key, kept_, progress), surface);
    if (sized <= input.budget.max_tokens || kept_.length === 0) {
      kept = kept_;
      break;
    }
    kept_ = kept_.slice(0, Math.max(0, kept_.length - 1));
  }

  const hasMore = kept.length < total;
  const progress: Record<string, unknown> = hasMore
    ? { continuation: { result_id: input.resultId, cursor: "", rows_left: total - kept.length, total } }
    : {};
  const finalTokens = measure(replaceRows(input.value, found.key, kept, progress), {
    omission: [...omissions, ...(hasMore ? [{ stage: "budget", reason: "" }] : [])],
    ...progress,
  });

  if (kept.length < total) {
    const cursor = makeCursor({ result_id: input.resultId, ...input.binding }, kept.length);
    (progress.continuation as Continuation).cursor = cursor;

    if (mode === "error") {
      omissions.push({
        stage: "budget",
        reason: `result needs ${total} rows to fit the contract but the budget only holds ${kept.length}; overflow=error was requested`,
        rows_total: total, rows_returned: kept.length, rows_omitted: total - kept.length,
        next_cursor: null,
      });
      report.measured_tokens = finalTokens;
      return { value: input.value, report, omissions };
    }

    omissions.push({
      stage:  "budget",
      reason: `${total - kept.length} of ${total} row(s) were left out to fit ${input.budget.max_tokens} tokens`,
      rows_total: total, rows_returned: kept.length, rows_omitted: total - kept.length,
      next_cursor: cursor,
    });
  }

  if (input.captureTruncated) {
    /** 수집 상한에 걸렸으면 전체 행 수를 알지 못한다. 모르는 것을 숫자로 꾸미지 않는다. */
    omissions.push({
      stage:  "capture",
      reason: "output was cut at the capture limit: the total row count is not known",
      unknown_counts: { rows_total: 1 },
    });
  }
  if (input.parseFailed) {
    omissions.push({ stage: "parse", reason: "no parser produced a structure for this output" });
  } else if (input.silentEmpty) {
    omissions.push({ stage: "parse", reason: "the parser recognized nothing in the data lines" });
  }
  if (input.privacyApplied) {
    omissions.push({ stage: "privacy", reason: "values were replaced before counting, so the budget applies to the masked result" });
  }
  if (input.projectionOmitted > 0) {
    omissions.push({
      stage: "projection", reason: `${input.projectionOmitted} row(s) were removed by where/sort/limit before counting`,
      rows_omitted: input.projectionOmitted,
    });
  }

  const finalValue = replaceRows(input.value, found.key, kept, progress);
  report.measured_tokens = finalTokens;
  report.budget_met = finalTokens <= input.budget.max_tokens;

  return {
    value:      finalValue,
    report,
    omissions,
    ...(hasMore && { continuation: progress.continuation as Continuation }),
  };
}

/**
 * 값 안의 행 배열을 교체하고 표면을 덧붙인다. 원본은 건드리지 않는다.
 * 최상위 값이 배열이면(행 배열 그 자체) 표면을 붙일 자리가 없으므로 객체로 감싼다.
 */
export function replaceRows(
  value: unknown, key: string, rows: unknown[], tail: Record<string, unknown> = {},
): Record<string, unknown> {
  if (key === "") {
    /** 최상위 배열에 진행 정보를 붙이려면 형태를 바꿔야 한다. 병합 결과로 감싸 그 사실을 드러낸다. */
    return Array.isArray(value) ? { rows, ...tail } : { rows, ...tail };
  }
  if (typeof value !== "object" || value === null) return { value, ...tail };
  return { ...(value as Record<string, unknown>), [key]: rows, ...tail };
}

/** 지원하지 않는 토크나이저 이름을 확인한다. 조용히 대체하지 않는다. */
export function validateTokenizer(name: string | undefined): { ok: true; id: TokenizerId } | { ok: false; message: string } {
  if (name === undefined) return { ok: true, id: "parism/approx" };
  if (!isSupportedTokenizer(name)) {
    return {
      ok: false,
      message: `tokenizer '${name}' is not supported; use one of: parism/approx, byte. An estimate is not reported as an exact budget.`,
    };
  }
  return { ok: true, id: name };
}

/** 예산이 최소 봉투조차 못 담는 상태인가. 실행 전에 거절할 때 쓴다. */
export function budgetTooSmall(budget: BudgetRequest, _tokenizer: TokenizerId): boolean {
  return budget.max_tokens < MINIMUM_ENVELOPE_TOKENS;
}

export type { Completeness };
