/**
 * 결과의 재검토(review) 정보와 필드 근거를 만든다.
 *
 * 목표는 값의 출처를 바로 열어 주는 것이지, 그 값이 참이라는 보증을 만드는 것이 아니다.
 * 명령이 거짓을 출력하거나 환경이 바뀌면 근거는 '그 시점 출력의 증거'일 뿐이다.
 *
 * 작성자: 최진호
 * 작성일: 2026-10-05
 */

import {
  toByteSpan, hashContent, newResultId,
  type Completeness, type FieldEvidence, type LineIndex, type RawEvidence, type Review, type SourceSpan,
} from "./evidence.js";
import { mapRange, type MaskedRange } from "./mask-map.js";

export type FieldEvidenceMap = Record<string, FieldEvidence[]>;

/** 바이트 구간 표. SourceSpan 에 transform 이 함께 실린다. */
export type ByteSpanMap = Record<string, SourceSpan[]>;

/** review 를 만들 때 필요한 입력 */
export interface ReviewInput {
  cmd:                string;
  parserId:           string;
  /** native JSON 폴백이 값을 냈는지 */
  native:             boolean;
  /** 실행 출력이 잘렸는지 */
  truncated:          boolean;
  /** 파서가 조용히 빈 결과를 냈는지 */
  silentEmpty:        boolean;
  /** 파싱 결과가 없었는지 */
  parsedMissing:      boolean;
  /** 표시 변환이 값을 보존했는지 */
  representationLossless: Completeness;
  /** 마스킹이 원문을 바꿨는지 */
  masked:             boolean;
  /** 사용자에게 보여줄 정규 원문(마스킹 후) */
  canonicalStdout:    string;
  canonicalStderr:    string;
  /** 엔벨로프 응답 봉투의 스키마 버전 */
  schemaVersion:      string;
  warnings:           string[];
}

export const ENVELOPE_SCHEMA_VERSION = "parism/1.1";

/** 재검토 정보를 만든다. 삼각 측량 없이 '알 수 없음'을 정직하게 남긴다. */
export function buildReview(input: ReviewInput, resultId: string): Review {
  /**
   * 파싱이 실패했거나 native JSON 폴백이 값을 냈으면, 레코드를 다 인식했다고 말할 수 없다.
   * '없다'가 아니라 '확인하지 못했다'로 둔다.
   */
  const parseComplete: Completeness =
    input.silentEmpty || input.parsedMissing ? false
    : input.native                   ? "unknown"
    :                                true;

  return {
    result_id:   resultId,
    parser_id:   input.parserId,
    parser_version: input.schemaVersion,
    content_hash: hashContent(input.canonicalStdout),
    schema_version: ENVELOPE_SCHEMA_VERSION,
    source_complete:      input.truncated ? false : true,
    parse_complete:       parseComplete,
    representation_lossless: input.representationLossless,
    privacy_transform:    input.masked ? "masked" : "none",
    retained:             false,
    warnings:             input.warnings,
  };
}

/**
 * 파서가 준 문자열 위치 표를 바이트 구간 근거로 바꾼다.
 * 바이트 오프셋은 마스킹된 정규 원문의 기준이다(계산된 신호가 유출되지 않게).
 */
export function toFieldEvidence(
  raw:      RawEvidence,
  index:    LineIndex,
  valueAt:  (pointer: string) => unknown,
): FieldEvidenceMap {
  const out: FieldEvidenceMap = {};
  for (const [pointer, spans] of Object.entries(raw)) {
    const outSpans: SourceSpan[] = [];
    let   transform: string | undefined;
    for (const span of spans) {
      const bytes = toByteSpan(index, span.line, span.start, span.end);
      if (!bytes) continue;
      /** 원문에 그대로 있는 구간만 verbatim 이다. 변환이 끼면 derived 로 밝힌다. */
      if (span.transform === undefined) transform = undefined;
      else transform = span.transform;
      outSpans.push({
        source:  span.source,
        start:   bytes.start,
        end:     bytes.end,
        line:    span.line,
        ...(span.record !== undefined && { record: span.record }),
      });
    }
    if (outSpans.length === 0) continue;
    out[pointer] = [{
      value:         valueAt(pointer),
      source_kind:   transform === undefined ? "verbatim" : "derived",
      source_spans:  outSpans,
      ...(transform && { transform }),
      masked:        false,
    }];
  }
  return out;
}

/** 원문 구간이 실제로 그 값을 담는지 확인한다. 다른 내용이면 근거가 아니므로 버린다. */
export function verifySpans(
  text:  string,
  spans: readonly SourceSpan[],
  value: unknown,
): { ok: true } | { ok: false; reason: string } {
  if (typeof value === "number") {
    /**
     * 숫자는 수치로 대조한다. "0.0" 과 0, "1.20" 과 1.2 처럼 표기가 달라도 값이 같으면 근거다.
     * 문자열로 바꾸어 비교하면 같은 값을 다른 값으로 판단한다.
     */
    for (const span of spans) {
      const slice = text.slice(span.start, span.end);
      if (slice.trim() !== "" && Number(slice) === value) return { ok: true };
    }
    return { ok: false, reason: `no span holds this number; spans read ${JSON.stringify(text.slice(spans[0]!.start, spans[0]!.end))}` };
  }
  if (typeof value !== "string") {
    const text2 = text.slice(spans[0]!.start, spans[0]!.end);
    return String(value) === text2 ? { ok: true } : { ok: false, reason: `span text ${JSON.stringify(text2)} does not match value ${JSON.stringify(value)}` };
  }
  for (const span of spans) {
    if (text.slice(span.start, span.end) === value) return { ok: true };
  }
  return { ok: false, reason: "no span holds this value" };
}

/** 각 문자 위치의 UTF-8 누적 바이트 수. 마스킹된 원문에서 문자 위치를 바이트로 바꾸는 데 쓴다. */
export function byteOffsetsOf(text: string): number[] {
  const offsets = new Array<number>(text.length + 1);
  let bytes = 0;
  for (let i = 0; i < text.length; i++) {
    offsets[i] = bytes;
    const code = text.codePointAt(i)!;
    if (code > 0xffff) {
      /** utf-16 서로게이트 쌍은 코드포인트 하나로 세야 바이트 수가 맞는다 */
      bytes += 4;
      i += 1;
      offsets[i] = bytes - 4;
    } else if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else bytes += 3;
  }
  offsets[text.length] = bytes;
  return offsets;
}

/**
 * 파서가 준 근거(마스킹 전 문자열 좌표)를 마스킹된 정규 원문의 바이트 구간으로 바꾼다.
 * 마스킹 구간 안에 걸린 값은 치환 토큰을 가리키며, 그 사실이 masked 로 드러난다.
 */
export function evidenceToByteSpans(
  raw:       RawEvidence,
  unmasked:  LineIndex,
  maskedText: string,
  ranges:    readonly MaskedRange[],
): Record<string, SourceSpan[]> {
  const maskedBytes = byteOffsetsOf(maskedText);
  const out: Record<string, SourceSpan[]> = {};

  for (const [pointer, spans] of Object.entries(raw)) {
    const converted: SourceSpan[] = [];
    const lineOffsets = lineCharOffsets(unmasked);
    for (const span of spans) {
      /**
       * line=0 은 줄 구분과 무관한 NUL 레코드용이다(경로에 개행이 있어도 정확해야 한다).
       * 이때 start/end 는 원문 전체 기준 절대 문자 위치다.
       */
      const lineStart = span.line === 0 ? 0 : lineOffsets[span.line - 1];
      if (lineStart === undefined) continue;
      const from = lineStart + span.start;
      const to   = lineStart + span.end;
      const mapped = mapRange(ranges, from, to);
      /** 마스킹 뒤 문자열을 넘으면 구간이 더 이상 유효하지 않다 */
      if (mapped.start < 0 || mapped.end > maskedText.length || mapped.end < mapped.start) continue;
      converted.push({
        source:  span.source,
        start:   maskedBytes[mapped.start]!,
        end:     maskedBytes[mapped.end]!,
        line:    span.line,
        ...(span.record !== undefined && { record: span.record }),
        ...(span.transform && { transform: span.transform }),
      });
    }
    if (converted.length > 0) out[pointer] = converted;
  }
  return out;
}

/** 줄의 첫 문자 위치를 구한다. */
function lineCharOffsets(index: LineIndex): number[] {
  const starts: number[] = [];
  let at = 0;
  for (const line of index.lines) {
    starts.push(at);
    at += line.length + 1;
  }
  return starts;
}

/** 결과 식별자를 새로 만든다 */
export function mintResultId(): string {
  return newResultId();
}
