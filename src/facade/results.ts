/**
 * 보관된 결과를 다시 읽는 연산. 명령을 다시 실행하지 않는다.
 *
 *   queryResult    보관 결과에 where, sort_by, limit, select, aggregate를 다시 건다
 *   fetchResult    예산으로 자른 결과의 다음 페이지
 *   compareStored  보관 결과 두 개의 의미 diff
 *   explainResult  보관 결과 값 하나의 원문 바이트 구간
 *
 * 작성자: 최진호
 * 작성일: 2026-11-12
 */

import type { PrismConfig }                                                          from "../config/loader.js";
import type { ParserRegistry }                                                       from "../parsers/registry.js";
import { devloopRowsKey }                                                            from "../parsers/devloop/index.js";
import { applyProjection, hasProjection, parseProjection }                           from "../engine/projection.js";
import { countJsonTokens }                                                           from "../engine/budget/tokenizer.js";
import { applyBudget, decodeCursor, makeCursor, validateTokenizer, findRowArray, replaceRows } from "../engine/budget/index.js";
import { compareResults, type CompareOptions, type CompareResult, type CompareSide } from "../engine/compare/index.js";
import { resolvePointer, type ResultStore, type StoredResult }                       from "../engine/result-store.js";
import type { FieldEvidence }                                                        from "../engine/evidence.js";
import { sliceByBytes }                                                              from "../engine/review.js";
import type { ExplainResult, FetchResult, QueryResult }                              from "./envelope.js";
import type { PageStore }                                                            from "./run-budget.js";

export interface ResultDeps {
  config:   PrismConfig;
  registry: ParserRegistry;
  results:  ResultStore;
  pages:    PageStore;
}

/**
 * 보관된 결과에 다른 조건(where, sort_by, limit, select)을 걸어 돌려준다. 명령을 다시 실행하지 않는다.
 * 프로젝션 전의 파싱 결과에 적용하므로, 처음 실행 때 걸었던 조건과 무관하다.
 */
export function queryResult(deps: ResultDeps, resultId: string, query: Record<string, unknown>): QueryResult {
  const lookup = deps.results.get(resultId);
  if (!lookup.found) return { ok: false, result_id: resultId, reason: lookup.reason, message: lookup.message };
  const stored = lookup.result;
  const source = stored.source !== undefined ? stored.source : stored.parsed;
  if (source == null || (stored.source === undefined && stored.review.representation_lossless !== true)) {
    return { ok: false, result_id: resultId, reason: "no_parsed_result", message: `result '${resultId}' has no parsed value to query` };
  }
  const complete = stored.sourceComplete === true;
  if (!hasProjection(query)) {
    return { ok: true, result_id: resultId, age_ms: lookup.age_ms, value: source, source_complete: complete };
  }
  const projection = parseProjection(query);
  if (!projection.ok) return { ok: false, result_id: resultId, reason: projection.reason, message: projection.message };

  const rowsKey  = devloopRowsKey(stored.cmd, stored.args);
  const contract = deps.registry.contractFor(stored.cmd, stored.args);
  const shape    = rowsKey ? { ...contract, rowsKey } : contract;
  const out      = applyProjection(source, projection.options, shape, deps.config.guard.max_items);
  if (!out.ok) return { ok: false, result_id: resultId, reason: out.reason, message: out.message };
  /**
   * 보관본이 프로젝션 전의 결과 그대로일 때만 행의 원래 위치를 포인터로 돌려준다.
   * 이 포인터는 explain_result에 그대로 쓸 수 있다. 처음 실행에 프로젝션이 있었으면 근거가 남아 있지 않다.
   */
  const pointers = stored.source === undefined && out.indices
    ? out.indices.map(i => `${out.key === null ? "" : `/${out.key.replace(/~/g, "~0").replace(/\//g, "~1")}`}/${i}`)
    : undefined;
  return {
    ok: true, result_id: resultId, age_ms: lookup.age_ms, value: out.parsed,
    ...(Array.isArray(out.parsed) && { _summary: out.summary }),
    source_complete: complete,
    ...(pointers && { row_pointers: pointers }),
  };
}

/**
 * 저장된 결과의 다음 페이지를 재실행 없이 돌려준다.
 * 이미 만료·퇴출됐거나 진행 규칙이 어긋나면 그 사실을 알린다 — 임의 오프셋을 믿지 않는다.
 */
export function fetchResult(
  deps: ResultDeps, resultId: string, cursor: string, budget?: { max_tokens: number; tokenizer?: string },
): FetchResult {
  const decoded = decodeCursor(cursor);
  if (!decoded) {
    return { ok: false, reason: "cursor_invalid", message: "cursor is not a valid continuation token" };
  }
  if (decoded.binding.result_id !== resultId) {
    return { ok: false, reason: "cursor_mismatch", message: "cursor belongs to a different result" };
  }
  const page = deps.pages.get(resultId);
  if (!page) {
    const lookup = deps.results.get(resultId);
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
export function compareStored(deps: ResultDeps, baseId: string, currentId: string, options: CompareOptions & { strict?: boolean } = {}): CompareResult {
  const base    = sideFor(deps, baseId);
  const current = sideFor(deps, currentId);
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
function sideFor(deps: ResultDeps, resultId: string): CompareSide | null {
  const lookup = deps.results.get(resultId);
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
export function explainResult(deps: ResultDeps, resultId: string, pointer: string): ExplainResult {
  const lookup = deps.results.get(resultId);
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
  const chain = evidenceChain(stored, pointer);
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
function evidenceChain(stored: StoredResult, pointer: string): FieldEvidence[] {
  const key = pointer.startsWith("#") ? pointer.slice(1) : pointer;
  return stored.evidence[key] ?? [];
}
