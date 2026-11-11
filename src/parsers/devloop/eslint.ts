/**
 * eslint `--format json` 출력 파서.
 *
 * 파일별 errorCount, warningCount의 합과 읽은 메시지 수가 다르면 결과를 만들지 않는다.
 * 파일 원문(source)과 자동 수정 제안은 결과에 싣지 않는다.
 *
 * 작성자: 최진호
 * 작성일: 2026-11-11
 */

import { UnrecognizedOutputError, type ParseContext } from "../registry.js";
import { buildDiagnosticReport, type Diagnostic, type DiagnosticReport } from "./types.js";

interface EslintMessage {
  ruleId?:   string | null;
  severity?: number;
  message?:  string;
  line?:     number;
  column?:   number;
  fatal?:    boolean;
}

interface EslintFileResult {
  filePath?:     string;
  messages?:     EslintMessage[];
  errorCount?:   number;
  warningCount?: number;
}

function isFileResult(value: unknown): value is EslintFileResult {
  return value !== null && typeof value === "object" && typeof (value as EslintFileResult).filePath === "string"
    && Array.isArray((value as EslintFileResult).messages);
}

/** eslint JSON 출력을 진단 보고서로 바꾼다. JSON 배열이 아니면 null. */
export function parseEslint(raw: string, ctx?: ParseContext): DiagnosticReport | null {
  let value: unknown;
  try {
    value = JSON.parse(raw.trim());
  } catch {
    return null;
  }
  if (!Array.isArray(value) || !value.every(isFileResult)) return null;

  const diagnostics: Diagnostic[] = [];
  let   reported = 0;
  for (const file of value as EslintFileResult[]) {
    reported += (file.errorCount ?? 0) + (file.warningCount ?? 0);
    for (const m of file.messages ?? []) {
      diagnostics.push({
        file:     file.filePath!,
        ...(typeof m.line === "number" && { line: m.line }),
        ...(typeof m.column === "number" && { column: m.column }),
        severity: m.severity === 2 || m.fatal === true ? "error" : "warning",
        ...(typeof m.ruleId === "string" && { code: m.ruleId }),
        message:  typeof m.message === "string" ? m.message : "",
      });
    }
  }
  if (reported !== diagnostics.length) {
    throw new UnrecognizedOutputError(`eslint reported ${reported} problem(s) but ${diagnostics.length} message(s) were found`);
  }
  return buildDiagnosticReport("eslint", diagnostics, ctx?.maxItems ?? 0);
}
