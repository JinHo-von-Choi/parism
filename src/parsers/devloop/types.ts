/**
 * 시험 러너와 진단 도구(컴파일러, 린터) 결과의 공통 형태.
 *
 * 통과한 항목은 개수만 싣고, 실패 항목과 진단은 하나도 빼지 않는다.
 * 러너가 스스로 보고한 수와 파싱한 항목 수가 다르면 결과를 만들지 않는다(completeness.ts).
 *
 * 작성자: 최진호
 * 작성일: 2026-11-11
 */

/** 실패한 시험 한 건 */
export interface TestFailure {
  /** 결과 안에서 겹치지 않는 식별자. "파일 > 시험 전체 이름" 형태다. */
  id:       string;
  file:     string;
  /** 시험 전체 이름. 파일을 읽지 못한 실패는 "(file)"이다. */
  name:     string;
  line?:    number;
  column?:  number;
  message:  string;
  /** message가 길이 상한에서 잘렸을 때만 있다. 값은 잘리기 전의 글자 수다. */
  message_chars?: number;
}

export interface TestReport {
  kind:        "test";
  tool:        string;
  passed:      number;
  failed:      number;
  skipped:     number;
  todo:        number;
  total:       number;
  /** 시험을 실행하지 못한 파일 수(가져오기 오류, 문법 오류) */
  files_failed: number;
  success:     boolean;
  failures:    TestFailure[];
}

/** 컴파일러나 린터가 낸 진단 한 건 */
export interface Diagnostic {
  file?:    string;
  line?:    number;
  column?:  number;
  severity: "error" | "warning" | "info";
  code?:    string;
  message:  string;
}

export interface DiagnosticReport {
  kind:        "diagnostics";
  tool:        string;
  errors:      number;
  warnings:    number;
  infos:       number;
  /** 진단이 하나라도 있는 파일 수 */
  files:       number;
  /** 규칙·코드별 개수. 많은 순서다. */
  by_code:     { code: string; count: number }[];
  diagnostics: Diagnostic[];
  /** diagnostics가 항목 수 상한에서 잘렸을 때만 있다. 값은 실리지 않은 진단 수다. 개수 필드는 전체 기준이다. */
  diagnostics_omitted?: number;
}

export type DevloopReport = TestReport | DiagnosticReport;

/** 실패 메시지 한 건의 길이 상한(글자). 넘으면 앞부분만 싣고 원래 길이를 message_chars에 적는다. */
export const MESSAGE_CHAR_LIMIT = 2000;

/** 메시지를 상한에 맞춰 자른다. 잘랐으면 원래 길이를 함께 돌려준다. */
export function clipMessage(message: string): { message: string; message_chars?: number } {
  if (message.length <= MESSAGE_CHAR_LIMIT) return { message };
  return { message: message.slice(0, MESSAGE_CHAR_LIMIT), message_chars: message.length };
}

/** 코드별 개수를 많은 순서, 같으면 코드 이름 순서로 만든다. */
export function countByCode(diagnostics: readonly Diagnostic[]): { code: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const d of diagnostics) {
    if (d.code === undefined) continue;
    counts.set(d.code, (counts.get(d.code) ?? 0) + 1);
  }
  return [...counts].map(([code, count]) => ({ code, count }))
    .sort((a, b) => b.count - a.count || (a.code < b.code ? -1 : a.code > b.code ? 1 : 0));
}

/** 진단 목록으로 보고서를 만든다. maxItems가 양수면 목록만 자르고 개수는 전체 기준으로 둔다. */
export function buildDiagnosticReport(tool: string, diagnostics: Diagnostic[], maxItems: number): DiagnosticReport {
  const files   = new Set(diagnostics.map(d => d.file).filter((f): f is string => f !== undefined));
  const shown   = maxItems > 0 && diagnostics.length > maxItems ? diagnostics.slice(0, maxItems) : diagnostics;
  const omitted = diagnostics.length - shown.length;
  return {
    kind:     "diagnostics",
    tool,
    errors:   diagnostics.filter(d => d.severity === "error").length,
    warnings: diagnostics.filter(d => d.severity === "warning").length,
    infos:    diagnostics.filter(d => d.severity === "info").length,
    files:    files.size,
    by_code:  countByCode(diagnostics),
    diagnostics: shown,
    ...(omitted > 0 && { diagnostics_omitted: omitted }),
  };
}
