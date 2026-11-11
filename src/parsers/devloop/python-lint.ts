/**
 * ruff와 mypy의 JSON 출력 파서.
 *
 * ruff check --output-format json -- 문제 객체의 JSON 배열
 * mypy --output json               -- 한 줄에 진단 하나인 JSON
 *
 * 형식에 맞지 않는 원소나 줄이 있으면 결과를 만들지 않는다.
 *
 * 작성자: 최진호
 * 작성일: 2026-11-11
 */

import { UnrecognizedOutputError, type ParseContext } from "../registry.js";
import { buildDiagnosticReport, type Diagnostic, type DiagnosticReport } from "./types.js";

interface RuffItem {
  code?:     string | null;
  filename?: string;
  message?:  string;
  severity?: string;
  location?: { row?: number; column?: number };
}

/** ruff JSON 출력을 진단 보고서로 바꾼다. JSON 배열이 아니면 null이다. */
export function parseRuff(raw: string, ctx?: ParseContext): DiagnosticReport | null {
  let value: unknown;
  try {
    value = JSON.parse(raw.trim());
  } catch {
    return null;
  }
  if (!Array.isArray(value)) return null;

  const diagnostics: Diagnostic[] = (value as RuffItem[]).map((item, index) => {
    if (item === null || typeof item !== "object" || typeof item.filename !== "string" || typeof item.message !== "string") {
      throw new UnrecognizedOutputError(`ruff output item ${index} is not a diagnostic`);
    }
    return {
      file:     item.filename,
      ...(typeof item.location?.row === "number" && { line: item.location.row }),
      ...(typeof item.location?.column === "number" && { column: item.location.column }),
      severity: item.severity === "warning" ? "warning" : "error",
      ...(typeof item.code === "string" && { code: item.code }),
      message:  item.message,
    };
  });
  return buildDiagnosticReport("ruff", diagnostics, ctx?.maxItems ?? 0);
}

interface MypyItem {
  file?:     string;
  line?:     number;
  column?:   number;
  message?:  string;
  code?:     string | null;
  severity?: string;
}

/** mypy JSON 출력을 진단 보고서로 바꾼다. 출력이 비어 있으면 진단이 없는 보고서이고, 첫 줄이 JSON이 아니면 null이다. */
export function parseMypy(raw: string, ctx?: ParseContext): DiagnosticReport | null {
  const diagnostics: Diagnostic[] = [];
  let   seen = 0;
  for (const line of raw.split(/\r?\n/)) {
    if (line.trim() === "") continue;
    let item: MypyItem;
    try {
      item = JSON.parse(line) as MypyItem;
    } catch {
      if (seen === 0) return null;
      throw new UnrecognizedOutputError(`a mypy output line is not JSON: ${line.slice(0, 120)}`);
    }
    if (item === null || typeof item !== "object" || typeof item.file !== "string" || typeof item.message !== "string") {
      if (seen === 0) return null;
      throw new UnrecognizedOutputError("a mypy output line is not a diagnostic");
    }
    seen++;
    diagnostics.push({
      file:     item.file,
      ...(typeof item.line === "number" && item.line > 0 && { line: item.line }),
      /** mypy의 열은 0부터 센다. 다른 도구와 맞춰 1부터 세는 값으로 바꾼다. */
      ...(typeof item.column === "number" && item.column >= 0 && { column: item.column + 1 }),
      severity: item.severity === "error" ? "error" : item.severity === "warning" ? "warning" : "info",
      ...(typeof item.code === "string" && { code: item.code }),
      message:  item.message,
    });
  }
  return buildDiagnosticReport("mypy", diagnostics, ctx?.maxItems ?? 0);
}
