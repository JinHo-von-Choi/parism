/**
 * 개발 루프 파서의 필드 근거.
 *
 * 줄 단위로 결과를 내는 형식에서, 실패 항목과 진단의 값이 원문의 어느 구간에서 왔는지 돌려준다.
 *   tsc          -- 진단 줄의 파일, 줄, 열, 코드, 메시지
 *   mypy         -- JSON 줄의 file, code, message
 *   cargo build  -- compiler-message 줄의 code, message
 *   cargo test   -- "test 이름 ... FAILED" 줄의 이름
 *   go test      -- fail 이벤트 줄의 Test
 *
 * JSON 문서 하나(vitest, jest, eslint, ruff)와 보고서 파일(pytest)을 읽는 형식은 근거를 내지 않는다.
 * 보관하는 원문은 표준 출력이고, 그 형식들의 값은 표준 출력의 줄과 일대일로 대응하지 않는다.
 *
 * 근거 구간이 값과 맞는지는 엔진이 다시 확인한다(engine/review.ts의 verifySpans).
 * 맞지 않는 구간은 근거로 쓰이지 않으므로, 여기서는 맞을 가능성이 있는 구간만 낸다.
 *
 * 작성자: 최진호
 * 작성일: 2026-11-11
 */

import type { RawEvidence, RawSpan } from "../../engine/evidence.js";

const TSC_LOCATED  = /^(.+?)\((\d+),(\d+)\): (error|warning|message) (TS\d+): (.*)$/d;
const TSC_GLOBAL   = /^(error|warning|message) (TS\d+): (.*)$/d;
const CARGO_FAILED = /^test (.+) \.\.\. FAILED(?:, .*)?$/d;

function span(line: number, range: [number, number], transform?: string): RawSpan {
  return { source: "stdout", line, start: range[0], end: range[1], ...(transform && { transform }) };
}

function linesOf(raw: string): string[] {
  return raw.split("\n").map(l => l.endsWith("\r") ? l.slice(0, -1) : l);
}

/** tsc 진단 줄의 필드 구간. 진단 순서는 파서(tsc.ts)와 같다. */
export function tscEvidence(raw: string): RawEvidence {
  const out: RawEvidence = {};
  const lines = linesOf(raw);
  let   index = -1;
  for (let i = 0; i < lines.length; i++) {
    const line    = lines[i]!;
    const located = TSC_LOCATED.exec(line);
    const global  = located ? null : TSC_GLOBAL.exec(line);
    if (!located && !global) continue;
    index++;
    const at   = `/diagnostics/${index}`;
    const next = lines[i + 1];
    /** 이어지는 줄이 있는 메시지는 한 구간으로 가리킬 수 없다. */
    const singleLine = next === undefined || !/^\s+\S/.test(next);
    if (located) {
      const ix = located.indices!;
      out[`${at}/file`]   = [span(i + 1, ix[1]!)];
      out[`${at}/line`]   = [span(i + 1, ix[2]!, "parseInt")];
      out[`${at}/column`] = [span(i + 1, ix[3]!, "parseInt")];
      out[`${at}/code`]   = [span(i + 1, ix[5]!)];
      if (singleLine) out[`${at}/message`] = [span(i + 1, ix[6]!)];
    } else if (global) {
      const ix = global.indices!;
      out[`${at}/code`] = [span(i + 1, ix[2]!)];
      if (singleLine) out[`${at}/message`] = [span(i + 1, ix[3]!)];
    }
  }
  return out;
}

/** cargo test의 실패 줄에서 시험 이름 구간. 실패 순서는 파서(cargo.ts)와 같다. */
export function cargoTestEvidence(raw: string): RawEvidence {
  const out: RawEvidence = {};
  let   index = -1;
  linesOf(raw).forEach((line, i) => {
    const failed = CARGO_FAILED.exec(line);
    if (!failed) return;
    index++;
    out[`/failures/${index}/name`] = [span(i + 1, failed.indices![1]!)];
  });
  return out;
}

/**
 * JSON 줄 안에서 문자열 값이 그대로 적힌 구간. 이스케이프가 들어간 값은 원문과 글자가 달라 가리키지 않는다.
 * key를 주면 `"key": "값"` 또는 `"key":"값"` 형태로 찾는다.
 */
function jsonStringSpan(line: string, key: string, value: unknown): [number, number] | undefined {
  if (typeof value !== "string" || value === "") return undefined;
  const quoted = JSON.stringify(value);
  if (quoted.slice(1, -1) !== value) return undefined;
  for (const prefix of [`${JSON.stringify(key)}: `, `${JSON.stringify(key)}:`]) {
    const at = line.indexOf(prefix + quoted);
    if (at >= 0) return [at + prefix.length + 1, at + prefix.length + 1 + value.length];
  }
  return undefined;
}

function parseLine(line: string): Record<string, unknown> | null {
  try {
    const value = JSON.parse(line) as unknown;
    return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

/** mypy JSON 줄의 file, code, message 구간. 진단 순서는 줄 순서다. */
export function mypyEvidence(raw: string): RawEvidence {
  const out: RawEvidence = {};
  let   index = -1;
  linesOf(raw).forEach((line, i) => {
    if (line.trim() === "") return;
    const item = parseLine(line);
    if (!item) return;
    index++;
    for (const field of ["file", "code", "message"]) {
      const range = jsonStringSpan(line, field, item[field]);
      if (range) out[`/diagnostics/${index}/${field}`] = [span(i + 1, range)];
    }
  });
  return out;
}

/** cargo build JSON 줄의 code, message 구간. 진단으로 세는 줄의 기준은 파서(cargo.ts)와 같다. */
export function cargoBuildEvidence(raw: string): RawEvidence {
  const out: RawEvidence = {};
  let   index = -1;
  linesOf(raw).forEach((line, i) => {
    if (line.trim() === "") return;
    const entry   = parseLine(line);
    const message = entry?.reason === "compiler-message" ? entry.message as Record<string, unknown> | undefined : undefined;
    const level   = typeof message?.level === "string" ? message.level : "";
    if (!message || !(level.startsWith("error") || level === "warning" || level === "note" || level === "help")) return;
    index++;
    const text = jsonStringSpan(line, "message", message.message);
    if (text) out[`/diagnostics/${index}/message`] = [span(i + 1, text)];
    const code = jsonStringSpan(line, "code", (message.code as { code?: unknown } | null)?.code);
    if (code) out[`/diagnostics/${index}/code`] = [span(i + 1, code)];
  });
  return out;
}

/** go test의 fail 이벤트 줄에서 시험 이름 구간. 실패 순서는 파서(gotest.ts)와 같다. */
export function goTestEvidence(raw: string): RawEvidence {
  const out: RawEvidence = {};
  let   index = -1;
  linesOf(raw).forEach((line, i) => {
    if (line.trim() === "") return;
    const event = parseLine(line);
    if (!event || event.Action !== "fail" || typeof event.Test !== "string") return;
    index++;
    const range = jsonStringSpan(line, "Test", event.Test);
    if (range) out[`/failures/${index}/name`] = [span(i + 1, range)];
  });
  return out;
}
