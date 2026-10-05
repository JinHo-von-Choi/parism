/**
 * 파서 출력 불변식.
 * 파서 계약(headerLines, noise, rowsKey, rowLine, rowFields)을 기준으로 파싱 결과를 원본 출력과 대조한다.
 * 런타임에는 isSilentEmpty만 registry의 unrecognized_output 판정에 쓰이고, 나머지는 시험에서 쓴다.
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 */

import type { ParserContract }  from "./registry.js";
import { tryParseNativeJson }    from "./json-passthrough.js";

/** 불변식 이름 */
export type InvariantRule = "silent_empty" | "row_count" | "non_finite" | "field_names";

/** 불변식 위반 한 건 */
export interface InvariantViolation {
  rule:    InvariantRule;
  message: string;
}

/** 불변식 판정에 쓰는 계약 필드 */
export type OutputContract = Pick<ParserContract, "headerLines" | "noise" | "rowsKey" | "rowLine" | "rowFields" | "nulRecords" | "blankRecords">;

/** 출력에서 온 값이 아닌 메타 키. 빈 결과 판정에서 제외한다. */
const META_KEYS = new Set(["raw", "resource", "unit"]);

/**
 * 파싱 결과가 출력에서 아무 값도 인식하지 못했는지 판정한다.
 * 배열은 길이 0, 문자열은 "", 숫자는 0, 불리언은 false, null/undefined, 하위 객체는 재귀적으로 빈 경우를 기본값으로 본다.
 */
function isDefaultValue(value: unknown, top = false): boolean {
  if (value == null || value === "" || value === 0 || value === false) return true;
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value === "object") {
    return Object.entries(value as Record<string, unknown>)
      .every(([k, v]) => (top && (META_KEYS.has(k) || k.startsWith("_"))) || isDefaultValue(v));
  }
  return false;
}

/**
 * 메타 키를 뺀 최상위 값이 모두 유한한 숫자인 결과인지 판정한다(id -u의 { uid: 0 } 등).
 * 이런 결과는 파서가 숫자만 있는 출력을 그대로 읽은 것이므로 0도 인식된 값으로 본다.
 * 문자열·배열·하위 객체가 섞인 결과의 0은 기본값으로 남겨 인식 실패를 가리지 않는다.
 */
function isNumericRecord(value: unknown): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const fields = Object.entries(value as Record<string, unknown>).filter(([k]) => !META_KEYS.has(k) && !k.startsWith("_"));
  return fields.length > 0 && fields.every(([, v]) => typeof v === "number" && Number.isFinite(v));
}

/**
 * 계약 정규식을 실행한 뒤 얻는 줄 수. 격리 팩의 정규식은 워커에서만 실행되므로,
 * 그 결과는 워커가 돌려준 값을 그대로 쓴다(contract에 정규식 객체를 만들지 않는다).
 */
export interface ContractFacts {
  dataLines?: number;
  rowLines?: number;
}

/**
 * 머리 줄과 noise 패턴을 제외한 비공백 줄. nulRecords면 NUL로 끝나는 레코드를 줄로 본다.
 * blankRecords면 빈 줄도 데이터 줄이며 마지막 종결 문자 뒤의 빈 조각만 뺀다.
 * 정규식 계약이 격리 팩에서 왔으면 noise는 서술자이므로 실행하지 않고 줄을 그대로 둔다.
 */
function dataLines(raw: string, contract: OutputContract | undefined): string[] {
  const records = raw.split(contract?.nulRecords ? "\0" : /\r?\n/);
  if (contract?.blankRecords && records[records.length - 1] === "") records.pop();
  const lines = (contract?.blankRecords ? records : records.filter(l => l.trim())).slice(contract?.headerLines ?? 0);
  const noise = contract?.noise;
  return noise instanceof RegExp ? lines.filter(l => !noise.test(l)) : lines;
}

/** 머리 줄과 noise 패턴을 제외하고 남는 비공백 줄 수 */
export function countDataLines(raw: string, contract: OutputContract | undefined, facts?: ContractFacts): number {
  if (facts?.dataLines !== undefined) return facts.dataLines;
  return dataLines(raw, contract).length;
}

/**
 * 데이터 줄 가운데 행이 되는 줄 수. rowLine이 없으면 모든 데이터 줄이 행이다.
 * 출력 전체가 JSON 배열 문서이면(gh --json) 줄 수가 아니라 원소 수가 행 수다.
 */
export function countRowLines(raw: string, contract: OutputContract | undefined, facts?: ContractFacts): number {
  if (facts?.rowLines !== undefined) return facts.rowLines;
  const json = tryParseNativeJson(raw);
  if (Array.isArray(json)) return json.length;
  const lines   = dataLines(raw, contract);
  const rowLine = contract?.rowLine;
  return rowLine instanceof RegExp ? lines.filter(l => rowLine.test(l)).length : lines.length;
}

/**
 * 데이터 줄이 있는데 결과가 아무 값도 담지 않은 경우(조용한 빈 결과)인지 판정한다.
 * 숫자만 있는 결과의 0은 인식한 값으로 본다.
 */
export function isSilentEmpty(parsed: unknown, raw: string, contract: OutputContract | undefined, facts?: ContractFacts): boolean {
  return countDataLines(raw, contract, facts) > 0 && isDefaultValue(parsed, true) && !isNumericRecord(parsed);
}

/** 값 안의 유한하지 않은 숫자 위치(최대 limit개) */
function nonFinitePaths(value: unknown, at: string, out: string[], limit = 3): string[] {
  if (out.length >= limit) return out;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) out.push(at);
  } else if (Array.isArray(value)) {
    value.forEach((v, i) => nonFinitePaths(v, `${at}[${i}]`, out, limit));
  } else if (value !== null && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) nonFinitePaths(v, `${at}.${k}`, out, limit);
  }
  return out;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** _summary.truncated가 참이면 잘리기 전 전체 행 수 */
function totalBeforeTruncation(parsed: Record<string, unknown>): number | null {
  const summary = parsed._summary;
  return isRecord(summary) && summary.truncated === true && typeof summary.total === "number" ? summary.total : null;
}

/**
 * 파싱 결과를 원본 출력과 계약으로 대조해 위반 목록을 반환한다. 위반이 없으면 빈 배열이다.
 * - silent_empty: 데이터 줄이 있는데 결과가 비었다(행 배열이 비었거나 모든 값이 기본값).
 * - row_count:    rowsKey 배열의 길이가 행 줄 수와 다르다. _summary.truncated면 total과 비교한다.
 * - non_finite:   숫자 필드에 NaN, Infinity가 있다.
 * - field_names:  rowFields 밖의 필드 이름을 가진 행이 있다.
 * 시간 복잡도는 원본 줄 수와 결과 크기에 선형이다.
 */
export function checkInvariants(parsed: unknown, raw: string, contract: OutputContract | undefined, facts?: ContractFacts): InvariantViolation[] {
  const violations: InvariantViolation[] = [];

  const bad = nonFinitePaths(parsed, "$", []);
  if (bad.length > 0) violations.push({ rule: "non_finite", message: `non-finite number at ${bad.join(", ")}` });

  const rows = contract?.rowsKey && isRecord(parsed) ? parsed[contract.rowsKey] : undefined;
  if (!Array.isArray(rows)) {
    if (isSilentEmpty(parsed, raw, contract, facts)) {
      violations.push({ rule: "silent_empty", message: `nothing recognized in ${countDataLines(raw, contract, facts)} data line(s)` });
    }
    return violations;
  }

  const expected = countRowLines(raw, contract, facts);
  const actual   = totalBeforeTruncation(parsed as Record<string, unknown>) ?? rows.length;
  if (expected > 0 && rows.length === 0) {
    violations.push({ rule: "silent_empty", message: `'${contract!.rowsKey}' is empty but ${expected} row line(s) exist` });
  } else if (actual !== expected) {
    violations.push({ rule: "row_count", message: `'${contract!.rowsKey}' has ${actual} row(s) for ${expected} row line(s)` });
  }

  if (contract?.rowFields) {
    const allowed = new Set(contract.rowFields);
    const index   = rows.findIndex(r => !isRecord(r) || Object.keys(r).some(k => !allowed.has(k)));
    if (index >= 0) {
      const keys = isRecord(rows[index]) ? Object.keys(rows[index]).filter(k => !allowed.has(k)) : [typeof rows[index]];
      violations.push({ rule: "field_names", message: `row ${index} has field(s) outside the schema: ${keys.join(", ")}` });
    }
  }
  return violations;
}
