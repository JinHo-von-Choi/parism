/**
 * cargo 출력 파서.
 *
 * cargo test         -- libtest의 기본 텍스트 출력을 읽는다. 시험 바이너리마다 나오는 "test result:" 줄의
 *                       실패 수 합계와 "... FAILED" 줄의 수가 다르면 결과를 만들지 않는다.
 * cargo build, check -- `--message-format=json`의 줄 단위 JSON을 읽는다. JSON이 아닌 줄이 있거나
 *                       build-finished 줄이 없으면 결과를 만들지 않는다.
 *
 * 작성자: 최진호
 * 작성일: 2026-11-11
 */

import { UnrecognizedOutputError, type ParseContext } from "../registry.js";
import { buildDiagnosticReport, clipMessage, type Diagnostic, type DiagnosticReport, type TestFailure, type TestReport } from "./types.js";

const TEST_LINE   = /^test (.+) \.\.\. (ok|FAILED|ignored)(?:, .*)?$/;
const RESULT_LINE = /^test result: (?:ok|FAILED)\. (\d+) passed; (\d+) failed; (\d+) ignored; (\d+) measured; (\d+) filtered out/;
const BLOCK_START = /^---- (.+) stdout ----$/;
const PANIC_AT    = /panicked at ([^\s:][^:\n]*):(\d+):(\d+)/;

/** 실패 블록(---- 이름 stdout ---- 다음부터 다음 블록이나 실패 목록 전까지)을 이름별로 모은다. */
function failureBlocks(lines: readonly string[]): Map<string, string[]> {
  const blocks = new Map<string, string[]>();
  let   name: string | undefined;
  for (const line of lines) {
    const start = BLOCK_START.exec(line);
    if (start) {
      name = start[1]!;
      /** 같은 이름의 시험이 여러 바이너리에 있으면 블록을 순서대로 쌓는다. */
      blocks.set(name, [...(blocks.get(name) ?? []), "\u0000"]);
      continue;
    }
    if (name === undefined) continue;
    if (line === "failures:" || RESULT_LINE.test(line)) { name = undefined; continue; }
    blocks.get(name)!.push(line);
  }
  return blocks;
}

/** 이름에 해당하는 블록을 앞에서부터 하나 꺼낸다. */
function takeBlock(blocks: Map<string, string[]>, name: string): string {
  const all = blocks.get(name);
  if (!all) return "";
  const from = all.indexOf("\u0000");
  if (from < 0) return "";
  const next = all.indexOf("\u0000", from + 1);
  const body = all.slice(from + 1, next < 0 ? undefined : next);
  blocks.set(name, next < 0 ? [] : all.slice(next));
  return body.join("\n").trim();
}

/** cargo test 출력을 TestReport로 바꾼다. "test result:" 줄이 하나도 없으면 null이다. */
export function parseCargoTest(raw: string): TestReport | null {
  const lines   = raw.split(/\r?\n/);
  const totals  = { passed: 0, failed: 0, ignored: 0 };
  let   results = 0;
  const failedNames: string[] = [];

  for (const line of lines) {
    const result = RESULT_LINE.exec(line);
    if (result) {
      results++;
      totals.passed  += Number(result[1]);
      totals.failed  += Number(result[2]);
      totals.ignored += Number(result[3]);
      continue;
    }
    const test = TEST_LINE.exec(line);
    if (test && test[2] === "FAILED") failedNames.push(test[1]!);
  }
  if (results === 0) return null;
  if (failedNames.length !== totals.failed) {
    throw new UnrecognizedOutputError(
      `cargo reported ${totals.failed} failed test(s) but ${failedNames.length} FAILED line(s) were found`,
    );
  }

  const blocks = failureBlocks(lines);
  const used   = new Map<string, number>();
  const failures: TestFailure[] = failedNames.map(name => {
    const seen = (used.get(name) ?? 0) + 1;
    used.set(name, seen);
    const message  = takeBlock(blocks, name);
    const location = PANIC_AT.exec(message);
    return {
      id:   seen === 1 ? name : `${name} #${seen}`,
      file: location ? location[1]! : "",
      name,
      ...(location && { line: Number(location[2]), column: Number(location[3]) }),
      ...clipMessage(message),
    };
  });

  return {
    kind:         "test",
    tool:         "cargo",
    passed:       totals.passed,
    failed:       totals.failed,
    skipped:      totals.ignored,
    todo:         0,
    total:        totals.passed + totals.failed + totals.ignored,
    files_failed: 0,
    success:      totals.failed === 0,
    failures,
  };
}

/** 실행 중인 cargo test의 진행 상태 */
export interface CargoTestProgressSnapshot {
  passed:       number;
  failed:       number;
  skipped:      number;
  /** 지금까지 실패한 시험 이름 */
  failed_names: string[];
}

/**
 * cargo test 출력을 조각 단위로 받아 지금까지의 통과·실패 수를 센다.
 * 줄이 조각 사이에서 끊겨도 다음 조각에서 이어 읽는다.
 */
export class CargoTestProgress {
  private rest = "";
  private readonly state: CargoTestProgressSnapshot = { passed: 0, failed: 0, skipped: 0, failed_names: [] };

  push(text: string): void {
    const lines = (this.rest + text).split(/\r?\n/);
    this.rest   = lines.pop() ?? "";
    for (const line of lines) {
      const test = TEST_LINE.exec(line);
      if (!test) continue;
      if (test[2] === "ok")           this.state.passed++;
      else if (test[2] === "ignored") this.state.skipped++;
      else {
        this.state.failed++;
        this.state.failed_names.push(test[1]!);
      }
    }
  }

  snapshot(): CargoTestProgressSnapshot {
    return { ...this.state, failed_names: [...this.state.failed_names] };
  }
}

interface CargoSpan {
  file_name?:    string;
  line_start?:   number;
  column_start?: number;
  is_primary?:   boolean;
}

interface CargoLine {
  reason?:  string;
  success?: boolean;
  message?: { level?: string; message?: string; code?: { code?: string } | null; spans?: CargoSpan[] };
}

function severityOf(level: string): Diagnostic["severity"] | null {
  if (level.startsWith("error")) return "error";
  if (level === "warning")       return "warning";
  if (level === "note" || level === "help") return "info";
  return null;
}

/** cargo build/check의 `--message-format=json` 출력을 진단 보고서로 바꾼다. JSON 줄이 하나도 없으면 null이다. */
export function parseCargoBuild(raw: string, ctx?: ParseContext): DiagnosticReport | null {
  const diagnostics: Diagnostic[] = [];
  let   seen     = 0;
  let   finished = false;

  for (const line of raw.split(/\r?\n/)) {
    if (line.trim() === "") continue;
    let entry: CargoLine;
    try {
      entry = JSON.parse(line) as CargoLine;
    } catch {
      if (seen === 0) return null;
      throw new UnrecognizedOutputError(`a cargo output line is not JSON: ${line.slice(0, 120)}`);
    }
    if (entry === null || typeof entry !== "object" || typeof entry.reason !== "string") {
      if (seen === 0) return null;
      throw new UnrecognizedOutputError("a cargo output line has no reason field");
    }
    seen++;
    if (entry.reason === "build-finished") { finished = true; continue; }
    if (entry.reason !== "compiler-message" || !entry.message) continue;

    const severity = severityOf(entry.message.level ?? "");
    if (severity === null) continue;
    const span = entry.message.spans?.find(s => s.is_primary === true);
    diagnostics.push({
      ...(span?.file_name !== undefined && { file: span.file_name }),
      ...(typeof span?.line_start === "number" && { line: span.line_start }),
      ...(typeof span?.column_start === "number" && { column: span.column_start }),
      severity,
      ...(typeof entry.message.code?.code === "string" && { code: entry.message.code.code }),
      message: entry.message.message ?? "",
    });
  }
  if (seen === 0) return null;
  if (!finished) throw new UnrecognizedOutputError("cargo output ended without a build-finished line");
  return buildDiagnosticReport("cargo", diagnostics, ctx?.maxItems ?? 0);
}
