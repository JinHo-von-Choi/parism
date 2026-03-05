/**
 * 명령 stdout/stderr 필드. raw는 항상 보존되고, parsed는 파서 존재 시 채워진다.
 */
export interface OutputField {
  raw:    string;
  parsed: unknown | null;
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
 * Prism의 모든 명령 실행 결과가 따르는 응답 봉투.
 * - ok: 실행 성공 여부 (exitCode === 0)
 * - diff: State Tracker 미활성 시 null
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
  truncated?:  boolean;   // stdout이 max_output_bytes로 잘렸을 때 true
  page_info?:  PageInfo;  // run_paged 사용 시에만 채워짐
}
