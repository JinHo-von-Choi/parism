/**
 * tsc 진단 출력 파서. `--pretty false` 형식(터미널이 아닐 때의 기본 형식)을 읽는다.
 *
 *   src/a.ts(2,7): error TS2322: Type 'string' is not assignable to type 'number'.
 *   error TS5083: Cannot read file '/x/tsconfig.json'.
 *
 * 들여쓴 줄은 바로 앞 진단의 이어지는 설명이다. 그 밖에 형식에 맞지 않는 줄이 있으면
 * 결과를 만들지 않는다. 읽지 못한 줄을 버리면 진단을 빠뜨릴 수 있기 때문이다.
 *
 * 작성자: 최진호
 * 작성일: 2026-11-11
 */

import { UnrecognizedOutputError, type ParseContext } from "../registry.js";
import { buildDiagnosticReport, type Diagnostic, type DiagnosticReport } from "./types.js";

const LOCATED = /^(.+?)\((\d+),(\d+)\): (error|warning|message) (TS\d+): (.*)$/;
const GLOBAL  = /^(error|warning|message) (TS\d+): (.*)$/;
/** --pretty 없이도 일부 버전이 끝에 붙이는 합계 줄 */
const SUMMARY = /^Found (\d+) errors?(?: in .*)?\.?$/;

function severityOf(word: string): Diagnostic["severity"] {
  return word === "message" ? "info" : word as "error" | "warning";
}

/** tsc 출력을 진단 보고서로 바꾼다. 출력이 비어 있으면 진단이 없는 보고서다. */
export function parseTsc(raw: string, ctx?: ParseContext): DiagnosticReport {
  const diagnostics: Diagnostic[] = [];
  let   reportedErrors: number | undefined;

  for (const line of raw.split(/\r?\n/)) {
    if (line.trim() === "") continue;

    const located = LOCATED.exec(line);
    if (located) {
      diagnostics.push({
        file:     located[1]!,
        line:     Number(located[2]),
        column:   Number(located[3]),
        severity: severityOf(located[4]!),
        code:     located[5]!,
        message:  located[6]!,
      });
      continue;
    }
    const global = GLOBAL.exec(line);
    if (global) {
      diagnostics.push({ severity: severityOf(global[1]!), code: global[2]!, message: global[3]! });
      continue;
    }
    const summary = SUMMARY.exec(line);
    if (summary) {
      reportedErrors = Number(summary[1]);
      continue;
    }
    const last = diagnostics[diagnostics.length - 1];
    if (/^\s/.test(line) && last) {
      last.message += `\n${line.trimEnd()}`;
      continue;
    }
    throw new UnrecognizedOutputError(`a tsc output line is not a diagnostic: ${line.slice(0, 120)}`);
  }

  const errors = diagnostics.filter(d => d.severity === "error").length;
  if (reportedErrors !== undefined && reportedErrors !== errors) {
    throw new UnrecognizedOutputError(`tsc reported ${reportedErrors} error(s) but ${errors} were parsed`);
  }
  return buildDiagnosticReport("tsc", diagnostics, ctx?.maxItems ?? 0);
}
