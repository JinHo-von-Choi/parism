/**
 * jest 형식 JSON 보고서 파서. vitest의 json 리포터도 같은 형식을 낸다.
 *
 * vitest 5는 `--outputFile=/dev/stdout`으로 받으면 JSON 문서 뒤에 안내 문구를 같은 줄에 붙인다.
 * 그래서 출력 전체를 JSON으로 읽지 않고, 보고서 객체가 시작하는 자리부터 괄호가 닫히는 자리까지만 읽는다.
 *
 * 작성자: 최진호
 * 작성일: 2026-11-11
 */

import { UnrecognizedOutputError } from "../registry.js";
import { clipMessage, type TestFailure, type TestReport } from "./types.js";

interface JestAssertion {
  fullName?:        string;
  title?:           string;
  ancestorTitles?:  string[];
  status?:          string;
  failureMessages?: string[];
  location?:        { line?: number; column?: number } | null;
}

interface JestFileResult {
  name?:             string;
  status?:           string;
  message?:          string;
  assertionResults?: JestAssertion[];
}

interface JestReport {
  numTotalTests?:   number;
  numPassedTests?:  number;
  numFailedTests?:  number;
  numPendingTests?: number;
  numTodoTests?:    number;
  success?:         boolean;
  testResults?:     JestFileResult[];
}

/** 보고서 객체의 첫 키. 이 키로 시작하는 객체만 보고서로 본다. */
const REPORT_START = /\{\s*"num(?:TotalTestSuites|FailedTestSuites|PassedTestSuites|TotalTests)"/;

/**
 * 문자열 text의 start 위치에서 시작하는 JSON 객체가 끝나는 위치(닫는 괄호 다음)를 찾는다.
 * 문자열 안의 괄호와 이스케이프를 건너뛴다. 닫히지 않으면 -1이다.
 */
function endOfJsonObject(text: string, start: number): number {
  let depth    = 0;
  let inString = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (ch === "\\") i++;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{" || ch === "[") depth++;
    else if (ch === "}" || ch === "]") {
      depth--;
      if (depth === 0) return i + 1;
    }
  }
  return -1;
}

/** 출력에서 jest 형식 보고서 객체를 찾아 읽는다. 없으면 null. */
export function findJestReport(raw: string): JestReport | null {
  const match = REPORT_START.exec(raw);
  if (!match) return null;
  const end = endOfJsonObject(raw, match.index);
  if (end < 0) return null;
  try {
    const value = JSON.parse(raw.slice(match.index, end)) as unknown;
    return value !== null && typeof value === "object" && !Array.isArray(value) ? value as JestReport : null;
  } catch {
    return null;
  }
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** 실패 메시지의 스택에서 시험 파일의 첫 위치(줄, 열)를 찾는다. */
function locationIn(message: string, file: string): { line: number; column: number } | undefined {
  if (file === "") return undefined;
  const found = new RegExp(`${escapeRegExp(file)}:(\\d+):(\\d+)`).exec(message);
  return found ? { line: Number(found[1]), column: Number(found[2]) } : undefined;
}

/** 스택의 러너 내부 줄(node_modules 경로)을 빼고 메시지를 정리한다. */
function trimStack(message: string): string {
  return message.split("\n")
    .filter(line => !/^\s+at .*node_modules[\\/]/.test(line)
      && !/^\s+at (?:node:|file:\/\/.*node_modules|new Promise \(<anonymous>\))/.test(line))
    .join("\n").trimEnd();
}

/** 같은 식별자가 이미 있으면 "#2", "#3"을 붙여 겹치지 않게 한다. */
function uniqueId(base: string, used: Map<string, number>): string {
  const seen = (used.get(base) ?? 0) + 1;
  used.set(base, seen);
  return seen === 1 ? base : `${base} #${seen}`;
}

function count(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new UnrecognizedOutputError(`test report field '${field}' is not a count`);
  }
  return value;
}

/**
 * jest 형식 보고서를 TestReport로 바꾼다.
 * 러너가 보고한 실패 수(numFailedTests)와 실패 상태인 시험 수가 다르면 결과를 만들지 않는다.
 * 실패 항목은 항목 수 상한으로 자르지 않는다.
 */
export function parseJestReport(tool: string, raw: string): TestReport | null {
  const report = findJestReport(raw);
  if (!report) return null;

  const files    = Array.isArray(report.testResults) ? report.testResults : [];
  const failures: TestFailure[] = [];
  const used     = new Map<string, number>();
  let   failedTests = 0;
  let   filesFailed = 0;

  for (const file of files) {
    const fileName   = typeof file.name === "string" ? file.name : "";
    const assertions = Array.isArray(file.assertionResults) ? file.assertionResults : [];
    const failedHere = assertions.filter(a => a.status === "failed");

    for (const a of failedHere) {
      failedTests++;
      const name     = a.fullName ?? [...(a.ancestorTitles ?? []), a.title ?? ""].join(" ");
      const full     = trimStack((a.failureMessages ?? []).join("\n"));
      const location = a.location?.line !== undefined
        ? { line: a.location.line, column: a.location.column }
        : locationIn(full, fileName);
      failures.push({
        id:   uniqueId(`${fileName} > ${name}`, used),
        file: fileName,
        name,
        ...(location?.line !== undefined && { line: location.line }),
        ...(location?.column !== undefined && { column: location.column }),
        ...clipMessage(full),
      });
    }

    /** 파일을 읽지 못해 시험이 하나도 실행되지 않은 경우. 시험 수에는 들어가지 않으므로 따로 센다. */
    if (file.status === "failed" && failedHere.length === 0) {
      filesFailed++;
      failures.push({
        id:   uniqueId(`${fileName} > (file)`, used),
        file: fileName,
        name: "(file)",
        ...clipMessage(trimStack(typeof file.message === "string" ? file.message : "")),
      });
    }
  }

  const reportedFailed = count(report.numFailedTests, "numFailedTests");
  if (failedTests !== reportedFailed) {
    throw new UnrecognizedOutputError(
      `the runner reported ${reportedFailed} failed test(s) but ${failedTests} failed entr${failedTests === 1 ? "y was" : "ies were"} found`,
    );
  }

  return {
    kind:         "test",
    tool,
    passed:       count(report.numPassedTests, "numPassedTests"),
    failed:       reportedFailed,
    skipped:      count(report.numPendingTests ?? 0, "numPendingTests"),
    todo:         count(report.numTodoTests ?? 0, "numTodoTests"),
    total:        count(report.numTotalTests, "numTotalTests"),
    files_failed: filesFailed,
    success:      report.success === true,
    failures,
  };
}
