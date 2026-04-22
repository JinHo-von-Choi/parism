/**
 * 파서 예외 정보. 파서가 예외를 던졌을 때만 존재. "파서 없음"과 "파서 버그"를 구분한다.
 * schema_violation은 strict_schemas=true 시 Zod 검증 실패를 나타낸다.
 */
export interface ParseErrorField {
  reason:  "parser_exception" | "schema_violation";
  message: string;
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
}

/**
 * 명령 stdout/stderr 필드. raw는 항상 보존되고, parsed는 파서 존재 시 채워진다.
 * parse_error는 파서가 예외를 던졌을 때만 존재한다 (파서 없음과 구분).
 */
export interface OutputField {
  raw:         string;
  parsed:      unknown | null;
  parse_error?: ParseErrorField;
}

// 하위 호환 alias
export type StdoutField = OutputField;

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
  /**
   * @deprecated v0.6 부터는 `failure` 필드를 사용한다. 하위 호환을 위해 유지된다. v2.0.0 제거 예정.
   * Guard 차단 시에만 존재한다.
   */
  guard_error?: { reason: string; message: string };
}
