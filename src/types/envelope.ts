import type { FormatHint }        from "../parsers/format.js";
import type { ProjectionSummary } from "../engine/projection.js";

/**
 * 파서 예외 정보. 파서가 예외를 던졌을 때만 존재. "파서 없음"과 "파서 버그"를 구분한다.
 * schema_violation은 strict_schemas=true 시 Zod 검증 실패를 나타낸다.
 * hint는 unsupported_format일 때 같은 정보를 처리 가능한 형식으로 얻는 인자가 있으면 채워진다.
 */
export interface ParseErrorField {
  reason:  "parser_exception" | "schema_violation" | "unsupported_format" | "unrecognized_output";
  message: string;
  hint?:   FormatHint;
}

/**
 * 실행 실패 원인을 단일 구조로 정규화한다.
 * guard/exec/parse/config 네 가지 kind로 분류하며 기존 필드(guard_error, parse_error)와 병존한다.
 * kind=parse, reason=parser_not_found 는 ok=true인 정보성 실패다 (구조화 파싱 불가 알림).
 */
export interface FailureInfo {
  kind:    "guard" | "exec" | "parse" | "config";
  reason:  string;
  message: string;
  /** reason=unsupported_format일 때 같은 명령에 줄 대체 인자. 결과는 내장 파서나 native JSON 폴백이 처리한다. */
  hint?:   FormatHint;
}

/**
 * 명령 stdout/stderr 필드. raw는 항상 보존되고, parsed는 파서 존재 시 채워진다.
 * parse_error는 파서가 예외를 던졌을 때만 존재한다 (파서 없음과 구분).
 */
export interface OutputField {
  raw:         string;
  parsed:      unknown | null;
  parse_error?: ParseErrorField;
  /**
   * 투영(select, where, sort_by, limit) 요약. 파싱 결과가 최상위 배열일 때만 여기에 둔다.
   * 결과가 객체이면 요약은 parsed._summary에 있다.
   */
  _summary?:   ProjectionSummary;
}

// 하위 호환 alias
export type StdoutField = OutputField;

/**
 * 결과의 재검토 정보. contract_version='next' 로 요청했을 때만 채워진다.
 * 기존 필드의 뜻은 바꾸지 않는다. 삼각 측량(false)이 아니라 '확인하지 못함'(unknown)을 구분해 쓴다.
 */
export interface ReviewField {
  result_id:               string;
  parser_id:               string;
  parser_version:          string;
  content_hash:            string;
  schema_version:          string;
  source_complete:         true | false | "unknown";
  parse_complete:          true | false | "unknown";
  representation_lossless: true | false | "unknown";
  privacy_transform:       "none" | "masked" | "unknown";
  retained:                boolean;
  warnings:                string[];
}

/**
 * 파일시스템 변경 diff (Phase 2에서 채워짐).
 */
export interface DiffField {
  created:  string[];
  deleted:  string[];
  modified: string[];
}

/**
 * run_paged 응답에 포함되는 페이지 메타데이터.
 */
export interface PageInfo {
  page:        number;   // 0-indexed 현재 페이지
  page_size:   number;   // 페이지당 줄 수
  total_lines: number;   // stdout 전체 줄 수
  has_next:    boolean;  // 다음 페이지 존재 여부
  cache?:      { hit: boolean; age_ms: number }; // run_paged 가 저장된 실행 결과를 재사용했는지
  /** 요청한 page_size가 guard.max_page_size를 넘어 줄였을 때만 있는 원래 요청값 */
  requested_page_size?: number;
}

/**
 * 파이프라인 단계별 성능 메트릭.
 * config.telemetry.enabled=true일 때만 ResponseEnvelope에 포함된다.
 */
export interface TelemetryField {
  guard_ms:   number;
  exec_ms:    number;
  parse_ms:   number;
  redact_ms:  number;
  total_ms:   number;
  raw_bytes:  number;
}

/**
 * Prism의 모든 명령 실행 결과가 따르는 응답 봉투.
 * - ok: 실행 성공 여부 (exitCode === 0)
 * - diff: State Tracker 미활성 시 null
 * - failure: 정규화된 실패 정보 (guard/exec/parse 실패 시 채워짐, 기존 필드와 병존)
 */
export interface ResponseEnvelope {
  ok:          boolean;
  exitCode:    number;
  cmd:         string;
  args:        string[];
  cwd:         string;
  duration_ms: number;
  stdout:      OutputField;
  stderr:      OutputField;
  diff:        DiffField | null;
  truncated?:  boolean;      // stdout이 max_output_bytes로 잘렸을 때 true
  page_info?:  PageInfo;     // run_paged 사용 시에만 채워짐
  failure?:    FailureInfo;  // 정규화된 실패 원인 (선택적, 하위 호환)
  telemetry?:  TelemetryField; // config.telemetry.enabled=true 시에만 포함
  /** contract_version='next' 로 요청했을 때만 채워진다. 기존 필드에는 손대지 않는다. */
  review?:     ReviewField;
  /**
   * @deprecated v0.6 부터는 `failure` 필드를 사용한다. 하위 호환을 위해 유지된다. v2.0.0 제거 예정.
   * Guard 차단 시에만 존재한다.
   */
  guard_error?: { reason: string; message: string };
}
