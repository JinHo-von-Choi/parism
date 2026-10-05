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
  hashContent, newResultId,
  type Completeness, type LineIndex, type RawEvidence, type Review, type SourceSpan,
} from "./evidence.js";
import { mapRange, type MaskedRange } from "./mask-map.js";
import { unquoteCQuoted }     from "./c-quotes.js";

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
 * 원문 구간이 **인코딩된 표기**일 때 그 표기를 값으로 되돌리는 변환.
 *
 * ## 왜 이 표가 필요한가
 *
 * 구간이 가리키는 것이 **값 그 자체**가 아닐 수 있다. git 은 공백이나 비 ASCII 가 든 경로를
 * 따옴표로 감싸 출력하므로 실측에서 구간이 `"with space.ts"` 를 담고 있었고 값은 `with space.ts` 였다.
 * 정확한 문자열 대조만으로는 그 구간을 근거로 인정하지 못하고 엔진은 `source_kind: "none"` 으로
 * 낮춘다. **값을 지어내는 것은 아니지만, 증명할 수 있는 근거를 버리는 것이었다.**
 * (실측: 정확성 게이트 1,200 케이스에서 8,819건이 이 이유로 낮아졌다.)
 *
 * ## 무엇을 넣고 무엇을 빼나
 *
 * **인코딩을 가리키는 transform 만 넣는다.** `trim` 이나 `strip_tree_prefix` 는 넣지 않는다 —
 * 그 구간은 이미 다듬어진 값을 가리키므로 역변환을 해도 바뀌는 것이 없다.
 * 오히려 넣으면 불필요하게 느슨해져 여분의 공백이 붙은 구간까지 근거로 받아들인다.
 *
 * **대조는 여전히 정확히 같을 때만 통과한다.** 부분 일치도, 정규화도 허용하지 않는다.
 * 이 표를 쓰는 방향은 느슨해지는 쪽이 아니라
 * **아직 증명하지 못한 것을 증명된 것으로 바꾸는 쪽**으로만 한정한다.
 */
const TRANSFORM_DECODERS: Readonly<Record<string, (slice: string) => string>> = {
  unescape_c_quotes: unquoteCQuoted,
};

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
      const slice = sliceByBytes(text, span.start, span.end);
      if (slice.trim() !== "" && Number(slice) === value) return { ok: true };
    }
    return { ok: false, reason: `no span holds this number; spans read ${JSON.stringify(sliceByBytes(text, spans[0]!.start, spans[0]!.end))}` };
  }
  if (typeof value !== "string") {
    const text2 = sliceByBytes(text, spans[0]!.start, spans[0]!.end);
    return String(value) === text2 ? { ok: true } : { ok: false, reason: `span text ${JSON.stringify(text2)} does not match value ${JSON.stringify(value)}` };
  }
  /** 표기를 그대로 담는 구간이 있으면 그것으로 충분하다. */
  for (const span of spans) {
    if (sliceByBytes(text, span.start, span.end) === value) return { ok: true };
  }
  /**
   * 구간이 값의 인코딩이라면, 되돌린 것이 정확히 그 값일 때 근거다.
   *
   * 구간이 **선언한** 변환에 대한 역변환이 없으면 여기서 통과시키지 않는다.
   * 모르는 변환을 관대하게 대조하면 근거를 지어내는 쪽으로 기운다 —
   * 모른다고 말하는 편이 낫다.
   */
  for (const span of spans) {
    const decode = span.transform ? TRANSFORM_DECODERS[span.transform] : undefined;
    if (!decode) continue;
    if (decode(sliceByBytes(text, span.start, span.end)) === value) return { ok: true };
  }
  return { ok: false, reason: "no span holds this value" };
}

/**
 * 바이트 오프셋으로 문자열을 자른다.
 *
 * ## 왜 이 함수가 필요한가
 *
 * `evidenceToByteSpans` 는 근거 구간을 **문자 위치에서 바이트 위치로** 바꾼다. 바이트가 맞는 이유가 있다 —
 * 근거는 사람이 원문에서 **바이트**로 짚는 것이고, 마스킹·전송 경계와 어긋나지 않기 때문이다.
 *
 * 그런데 그 구간을 **문자열 인덱스로** 자르면 원본과 어긋난다. 원문에 비 ASCII 가 한 글이라도 있으면
 * 바이트 위치와 문자 위치가 다르기 때문이다. 실측: 한 저장소에 `emoji-😀.ts` 가 있고 그 뒤에
 * `plain.ts` 가 있으면 **`plain.ts` 의 근거 구간이 엉뚱한 곳을 가리켜** `source_kind: "none"` 이 되었다.
 * 이모지 한 글이 뒤의 모든 근거를 망가뜨렸다.
 *
 * **비 ASCII 가 앞에만 있어도 뒤가 무너지므로, "이 출력은 아스키여서 괜찮다" 는 보장도 되지 않는다.**
 *
 * 순수 ASCII 면 바이트와 문자 위치가 같으므로 표를 만들지 않는다(대부분의 출력이 이 경로다).
 */
export function sliceByBytes(text: string, start: number, end: number): string {
  const table = charIndexTableOf(text);
  if (table === undefined) return text.slice(start, end);
  const from = table[start] ?? text.length;
  const to   = table[end]   ?? text.length;
  return text.slice(from, to);
}

/** 마지막으로 쓴 원문의 표 하나만 기억한다. 엔진은 한 결과를 만들 때 같은 원문으로 포인터를 전부 돈다. */
let tableForText: string | undefined;
let tableForBytes: Int32Array | undefined;

/** 바이트 오프셋 → 문자 인덱스 표. 순수 ASCII 면 `undefined` (항등이므로 필요 없다). */
function charIndexTableOf(text: string): Int32Array | undefined {
  if (tableForText === text) return tableForBytes;
  /**
   * 아스키 외 문자가 없으면 바이트와 문자 위치가 같다 — 표를 만들 이유가 없다.
   *
   * 정규식 대신 코드 유닛을 직접 본다. 아스키 범위를 정규식에 쓰면 제어문자가 들어가
   * `no-control-regex` 에 걸리고, 그 규칙을 끄는 대가로 범위 검사를 통째로 놓치게 된다.
   * 서로게이트도 0x7F 보다 크므로 한 번의 검사로 충분하다.
   */
  let nonAscii = false;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) > 0x7f) { nonAscii = true; break; }
  }
  let table: Int32Array | undefined;
  if (nonAscii) {
    const bytes = byteOffsetsOf(text);
    const size  = bytes[bytes.length - 1]! + 1;
    table = new Int32Array(size);
    /**
     * table[b] = '바이트 b 부터 시작하는 문자 인덱스' 다.
     * bytes[i] 가 문자 i 의 시작 바이트이므로, 그 문자 몫을 **자기 구간에만** 채운다.
     *
     * 앞 바이트까지 함께 채우면 `table[0]` 처럼 경계가 계속 뒤 문자로 덮여써진다 —
     * 한 번 그렇게 되어 표가 있는 출력은 아스키 출력까지 함께 망가진다.
     * (실측에서 그렇게 망가졌고, 표가 있는 경우에만 재현됐다.)
     *
     * 한 글자가 여러 바이트를 차지하면 그 바이트들은 모두 그 글자로 되돌린다.
     * 서로게이트 쌍의 뒤 코드 단위는 시작 바이트가 앞과 같아 구간이 비게 되는데,
     * 쌍의 가운데를 가리키는 경계는 생기지 않으므로 비워 두는 편이 맞다.
     */
    for (let i = 0; i < bytes.length; i++) {
      const from = bytes[i]!;
      const to   = i + 1 < bytes.length ? bytes[i + 1]! : from + 1;
      for (let b = from; b < to && b < size; b++) table[b] = i;
    }
  }
  tableForText  = text;
  tableForBytes = table;
  return table;
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

  /**
   * 줄 시작 위치는 원문만으로 정해지고 반복 안에서 바뀌지 않는다.
   * 포인터마다 다시 계산하면 O(포인터 × 원문 길이) 이 되어,
   * 1MB 출력을 5천 행으로 나눈 fixture 에서 근거 하나를 만드는 데 2초가 걸렸다(실측).
   * 한 번만 계산한다.
   */
  const lineOffsets = lineCharOffsets(unmasked);

  for (const [pointer, spans] of Object.entries(raw)) {
    const converted: SourceSpan[] = [];
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
