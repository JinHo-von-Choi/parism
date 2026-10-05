/**
 * 필드 근거(explicit evidence) 계약.
 *
 * 근거는 "이 값이 원문의 어느 구간에서 나왔나"를 말하는 연결이다.
 * 그 값이 현실에서 참이라는 보증이 아니다. 명령이 거짓을 출력하거나 환경이 바뀌면 근거는 그 시점 출력의 증거일 뿐이다.
 *
 * 작성자: 최진호
 * 작성일: 2026-10-05
 */

import { createHash } from "node:crypto";

/** 근거의 성격 */
export type SourceKind =
  | "verbatim"  // 원문에 그대로 있는 구간
  | "derived"   // 여러 구간에서 계산하거나 변환해 얻은 값
  | "none";     // 원문에 대응 구간이 없다

/** 원문 구간. 마스킹된 정규 원문의 UTF-8 바이트 범위다. */
export interface SourceSpan {
  /** 어느 스트림의 구간인지 */
  source: "stdout" | "stderr";
  /** 마스킹된 정규 원문 기준 바이트 오프셋 [start, end) */
  start:  number;
  end:    number;
  /** 1부터 센 줄 번호(있으면) */
  line?:  number;
  /** 1부터 센 레코드 번호(있으면) */
  record?: number;
  /** 구간 텍스트에서 값까지 가는 변환. 없으면 원문에 그대로 있는 구간이다 */
  transform?: string;
}

/** 값 하나의 근거 */
export interface FieldEvidence {
  value:         unknown;
  source_kind:   SourceKind;
  source_spans:  SourceSpan[];
  /** derived 일 때 값을 얻은 방법. 예: "sum", "normalize" */
  transform?:    string;
  /** 마스킹으로 값이 가려졌는지 */
  masked:        boolean;
  /** 근거가 없게 된 이유 */
  reason?:       string;
}

/** 파서가 넘기는 근거 한 건. 문자열 인덱스로 준 위치를 엔진이 바이트로 바꾼다. */
export interface RawSpan {
  source:    "stdout" | "stderr";
  /** 1부터 센 줄 번호 */
  line:      number;
  /** 그 줄 안에서의 문자열 오프셋 [start, end) (UTF-16 코드유닛) */
  start:     number;
  end:       number;
  record?:   number;
  /**
   * 원문 구간에서 값까지 가는 변환.
   * "verbatim" 이면 구간 텍스트가 값 그 자체다. "parseInt" 같은 이름이 있으면 변환이 있었다는 뜻이라
   * derived 로 보고 그 변환을 밝힌다.
   */
  transform?: string;
}

/** 파서가 넘기는 근거 표. JSON Pointer -> 근거 목록 */
export type RawEvidence = Record<string, RawSpan[]>;

/**
 * 삼각 측량 없이 '알 수 없음'을 정직하게 표현하는 완성도 표기.
 * false 와 다른 의미다: true 는 확인했고, false 는 확인했고 위배됐고, unknown 은 확인하지 못했다.
 */
export type Completeness = true | false | "unknown";

/** 결과의 검토 정보. 기존 봉투 필드의 뜻은 바꾸지 않는다. */
export interface Review {
  /** 이 결과를 가리키는 식별자. retained=false 여도 결과 안에는 남는다 */
  result_id:            string;
  parser_id:            string;
  parser_version:       string;
  /** 원문 내용의 해시. 같으면 출처가 같음을 뜻한다(원격 인증이나 서명이 아니다) */
  content_hash:         string;
  schema_version:       string;
  /** 실행 출력이 잘리지 않았는지 */
  source_complete:      Completeness;
  /** 지원한 레코드를 모두 인식했는지 */
  parse_complete:       Completeness;
  /** 표시 변환이 값을 보존했는지 */
  representation_lossless: Completeness;
  /** 어떤 프라이버시 변환이 적용됐는지 */
  privacy_transform:    "none" | "masked" | "unknown";
  /** 서버가 결과를 보관했는지. false 면 continuation 을 약속하지 않는다 */
  retained:             boolean;
  warnings:             string[];
}

/** 줄 단위 UTF-8 바이트 시작 오프셋 표. 문자열 인덱스를 바이트 범위로 바꾸는 데 쓴다. */
export interface LineIndex {
  /** 각 줄의 시작 바이트 오프셋. 마지막 항목은 원문 끝 */
  lineStarts: number[];
  /** 줄 배열 (마스킹된 정규 원문 기준) */
  lines:     string[];
  /** 원문의 UTF-8 바이트 수 */
  byteLength: number;
}

/** 문자열의 UTF-8 바이트 수 */
export function byteLengthOf(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

/**
 * 줄 단위 오프셋 표를 만든다. 줄바꿈 구분자는 \n 으로 고정한다(원문 보존이 목적이므로 정규화하지 않는다).
 */
export function buildLineIndex(text: string): LineIndex {
  const lines: string[] = [];
  const lineStarts: number[] = [];
  let bytes = 0;
  let start = 0;
  for (let i = 0; i <= text.length; i++) {
    if (i === text.length || text[i] === "\n") {
      lines.push(text.slice(start, i));
      lineStarts.push(bytes);
      /** i<text.length 면 \n 하나가 뒤따른다 */
      bytes = bytes + byteLengthOf(text.slice(start, i)) + (i < text.length ? 1 : 0);
      start = i + 1;
    }
  }
  return { lineStarts, lines, byteLength: bytes };
}

/** 결과 식별자. 충돌을 피하려고 시간과 난수를 함께 쓴다. */
export function newResultId(now: number = Date.now()): string {
  return `r_${now.toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

/** 원문 내용의 해시. 같은 내용이면 같은 해시다. */
export function hashContent(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex").slice(0, 16);
}
