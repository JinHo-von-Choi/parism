/**
 * 재검토(review)와 근거(evidence)를 조립하는 모듈.
 *
 * ## 왜 분리했나
 *
 * 재검토 정보는 **"이 결과가 어디서 왔고 무엇이 빠졌는가"** 를 말한다.
 * 그 계산은 순수한 산술과 판정인데, 원래는 세션 상태(보관함)와 설정에 손을 댄다.
 * 그래서 `facade/engine.ts` 안에서 다른 코드와 뒤섞여 있었다.
 *
 * 여기서는 두 가지를 분명히 한다:
 *   - `buildEvidence` 는 **순수**다. 입력만으로 근거를 만든다.
 *   - `attachReview` 는 **부수 효과**가 있다. 보관함에 결과를 넣거나 빼기도 한다.
 *
 * 둘을 같은 파일에 둔 이유는 근거와 재검토가 **같은 입력**을 보기 때문이다.
 * 둘을 따로 흩어 놓으면 입력 조각을 맞추느라 둘 다 읽어야 한다.
 *
 * 작성자: 최진호
 * 작성일: 2026-10-22
 */

import type { PrismConfig }                                    from "../config/loader.js";
import type { ParserRegistry }                                 from "../parsers/registry.js";
import { resolvePointer, type StoredResult }                   from "../engine/result-store.js";
import { buildLineIndex, type FieldEvidence, type RawEvidence } from "../engine/evidence.js";
import { buildReview, evidenceToByteSpans, verifySpans }        from "../engine/review.js";
import { buildFingerprint, type UserContext }                   from "../engine/compare/fingerprint.js";
import { parseProjection }                                      from "../engine/projection.js";
import { PACKAGE_VERSION }                                      from "../version.js";
import type { MaskedRange }                                     from "../engine/mask-map.js";
import type { ResultStore }                                     from "../engine/result-store.js";
import type { ResponseEnvelope, ReviewField }                   from "../types/envelope.js";

// ── 입력 계약 ──────────────────────────────────────────────────────────────

export interface ReviewInput {
  cmd: string; args: string[]; cwd: string; resultId: string; context?: UserContext;
  parsed: unknown; final: unknown; native: boolean; truncated: boolean;
  silentEmpty: boolean; representation: boolean; evidenceReason?: string; compactApplied: boolean;
  rawEvidence: RawEvidence; unmaskedStdout: string;
  canonicalStdout: string; canonicalStderr: string;
  maskRanges: readonly MaskedRange[];
  wantRetain: boolean; projection: ReturnType<typeof parseProjection> | undefined;
}

// ── 보관 크기 ──────────────────────────────────────────────────────────────

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

// ── 근거 조립 ──────────────────────────────────────────────────────────────

/**
 * 파서가 준 문자열 위치를 마스킹된 정규 원문의 바이트 구간으로 바꾸고, 그 구간이 정말 그 값을
 * 담는지 확인한다. 확인되지 않으면 근거가 아니라 "근거 없음"으로 남긴다.
 */
export function buildEvidence(
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

// ── 재검토 조립 ────────────────────────────────────────────────────────────

/**
 * 결과의 재검토 정보를 붙이고, 보관 요청이 있으면 세션에 담아 둔다.
 * 재검토 정보는 기존 봉투 필드의 뜻을 바꾸지 않는다.
 *
 * @param results 보관함. 보관과 보관을 취소하는 표시를 여기서 한다.
 * @param registry 파서 등록부 — 이 명령에 파서가 있는지 본다.
 * @param config   설정 — 비교 지문에 쓸 가드 정책이 여기 있다.
 */
export function attachReview(
  envelope: ResponseEnvelope,
  input: ReviewInput,
  deps: { results: ResultStore; registry: ParserRegistry; config: PrismConfig },
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
   * 투영이 행의 순서나 자리를 바꾸면 원래 포인터가 결과의 행을 가리키지 않는다.
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
      parserId:           input.native ? "native_json" : deps.registry.hasParser(input.cmd) ? input.cmd : "none",
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
    deps.results.markNotRetained(input.resultId);
    return review;
  }

  const evidence = buildEvidence(input);
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
    bytes:     storedBytesOf(input, evidence, deps.results.perResultLimit),
    cmd:       input.cmd,
    args:      input.args,
    cwd:       input.cwd,
    fingerprint: buildFingerprint({
      cmd:    input.cmd,
      args:   input.args,
      cwd:    input.cwd,
      policy: deps.config.guard,
      review,
      context: input.context,
      env:    process.env,
    }),
  };
  const put = deps.results.put(stored);
  if (!put.retained) {
    return { ...review, retained: false, warnings: [...review.warnings, put.reason ?? "result was not retained"] };
  }
  return { ...review, retained: true };
}
