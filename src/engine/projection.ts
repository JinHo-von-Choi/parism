/**
 * 응답 투영과 필터.
 * 파싱 결과의 최상위 배열 하나에 where, sort_by, limit, select를 이 순서로 적용한다. stdout.raw는 다루지 않는다.
 *
 * 문법(PROJECTION_SCHEMA):
 *   select  -- 남길 필드 이름 목록(1~64개). 행마다 지정한 순서로 남기고, 행에 없는 필드는 만들지 않는다.
 *   where   -- 조건 목록(1~16개). 모든 조건이 맞는 행만 남긴다. 조건은 { field, op, value }다.
 *              eq, ne       : 값은 문자열, 유한한 수, 불리언, null. null이 아닌 값은 필드 값과 형이 같아야 한다.
 *                             eq null은 필드 값이 없는(null 또는 누락) 행, ne null은 값이 있는 행이다.
 *              prefix, contains : 값은 문자열. 필드 값은 문자열이어야 하며 대소문자를 구분한다.
 *              gt, gte, lt, lte : 값은 유한한 수. 필드 값은 수여야 한다.
 *              필드 값이 없는 행은 prefix, contains, 수 비교에 맞지 않고, null이 아닌 값의 ne에는 맞는다.
 *   sort_by -- { field, order? }. order는 asc(기본) 또는 desc. 같은 값의 행은 원래 순서를 지키고,
 *              값이 없는 행은 방향과 관계없이 뒤에 둔다. 값이 있는 행의 형은 수, 문자열, 불리언 가운데 하나로 같아야 한다.
 *   limit   -- 남길 행 수(0 이상 정수). 0이면 행 없이 _summary만 남는다.
 *   array   -- 대상 배열의 키. 없으면 파서 계약의 rowsKey, 그것도 없으면 결과의 유일한 배열이다.
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 */

import { z } from "zod";

const FIELD_NAME = z.string().min(1).max(128);

/** where 조건 한 건 */
export const WHERE_CONDITION_SCHEMA = z.union([
  z.object({ field: FIELD_NAME, op: z.enum(["eq", "ne"]), value: z.union([z.string(), z.number().finite(), z.boolean(), z.null()]) }).strict(),
  z.object({ field: FIELD_NAME, op: z.enum(["prefix", "contains"]), value: z.string() }).strict(),
  z.object({ field: FIELD_NAME, op: z.enum(["gt", "gte", "lt", "lte"]), value: z.number().finite() }).strict(),
]);

export const SORT_SCHEMA = z.object({ field: FIELD_NAME, order: z.enum(["asc", "desc"]).optional() }).strict();

/** run 도구와 RunOptions가 함께 쓰는 투영 인자 모양 */
export const PROJECTION_SHAPE = {
  select:  z.array(FIELD_NAME).min(1).max(64).optional(),
  where:   z.array(WHERE_CONDITION_SCHEMA).min(1).max(16).optional(),
  sort_by: SORT_SCHEMA.optional(),
  limit:   z.number().int().min(0).optional(),
  array:   FIELD_NAME.optional(),
};

export const PROJECTION_SCHEMA = z.object(PROJECTION_SHAPE).strict();

/** run 도구와 RunOptions 가 함께 쓰는 토큰 예산 인자 모양 */
export const BUDGET_SHAPE = z.object({
  max_tokens:      z.number().int().min(1),
  tokenizer:       z.enum(["parism/approx", "byte"]).optional(),
  required_fields: z.array(FIELD_NAME).min(1).max(64).optional(),
  overflow:        z.enum(["page", "error"]).optional(),
}).strict();


export type WhereCondition    = z.infer<typeof WHERE_CONDITION_SCHEMA>;
export type SortSpec          = z.infer<typeof SORT_SCHEMA>;
export type ProjectionOptions = z.infer<typeof PROJECTION_SCHEMA>;

/** 투영 결과 요약. total은 대상 배열의 행 수, matched는 where를 통과한 행 수, shown은 남긴 행 수다. */
export interface ProjectionSummary {
  total:             number;
  matched:           number;
  shown:             number;
  /** 보이는 행을 guard.max_items 상한으로 잘랐을 때만 true */
  truncated?:        true;
  /** 결과 객체 안에서 대상이 아닌 배열 가운데 guard.max_items 상한으로 자른 배열의 키 */
  truncated_arrays?: string[];
}

export type ProjectionErrorReason = "invalid_projection" | "array_not_found" | "array_ambiguous" | "unknown_field" | "type_mismatch";

export type ProjectionOutcome =
  | { ok: true;  parsed: unknown; rows: unknown[]; summary: ProjectionSummary }
  | { ok: false; reason: ProjectionErrorReason; message: string };

/** 대상 배열을 고르고 필드 이름을 검사하는 데 쓰는 파서 계약의 출력 모양 */
export interface ProjectionShape {
  rowsKey?:   string;
  rowFields?: readonly string[];
}

/** 투영 인자가 하나라도 있는지 */
export function hasProjection(options: Partial<ProjectionOptions>): boolean {
  return options.select !== undefined || options.where !== undefined || options.sort_by !== undefined
    || options.limit !== undefined || options.array !== undefined;
}

/**
 * 검사하지 않은 입력을 문법으로 검사한다. 실패하면 invalid_projection 결과를 돌려준다.
 */
export function parseProjection(input: unknown): { ok: true; options: ProjectionOptions } | { ok: false; reason: "invalid_projection"; message: string } {
  const parsed = PROJECTION_SCHEMA.safeParse(input);
  if (parsed.success) return { ok: true, options: parsed.data };
  const issues = parsed.error.issues.map(i => `${i.path.length > 0 ? i.path.join(".") + ": " : ""}${i.message}`).join("; ");
  return { ok: false, reason: "invalid_projection", message: `Invalid select/where/sort_by/limit/array: ${issues}` };
}

class ProjectionError extends Error {
  constructor(public readonly reason: ProjectionErrorReason, message: string) {
    super(message);
    this.name = "ProjectionError";
  }
}

type Row = Record<string, unknown>;

function isRow(value: unknown): value is Row {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 필드 값. 자기 속성만 읽고 null과 누락은 undefined로 모은다. */
function fieldOf(row: Row, field: string): unknown {
  return Object.hasOwn(row, field) ? row[field] ?? undefined : undefined;
}

function typeName(value: unknown): string {
  if (Array.isArray(value)) return "array";
  if (value === null) return "null";
  return typeof value;
}

/** 대상 배열과 결과 안의 키(최상위 배열이면 null)를 고른다. */
function pickTarget(parsed: unknown, array: string | undefined, rowsKey: string | undefined): { key: string | null; rows: unknown[] } {
  if (Array.isArray(parsed)) {
    if (array !== undefined) throw new ProjectionError("array_not_found", `The parsed result is itself an array; omit 'array' (got '${array}')`);
    return { key: null, rows: parsed };
  }
  if (!isRow(parsed)) throw new ProjectionError("array_not_found", "The parsed result has no array to project");

  const arrays = Object.keys(parsed).filter(k => Array.isArray(parsed[k]));
  if (array !== undefined) {
    if (arrays.includes(array)) return { key: array, rows: parsed[array] as unknown[] };
    throw new ProjectionError("array_not_found", `No array '${array}' in the parsed result; arrays: ${arrays.join(", ") || "(none)"}`);
  }
  if (rowsKey !== undefined && arrays.includes(rowsKey)) return { key: rowsKey, rows: parsed[rowsKey] as unknown[] };
  if (arrays.length === 1) return { key: arrays[0]!, rows: parsed[arrays[0]!] as unknown[] };
  if (arrays.length === 0) throw new ProjectionError("array_not_found", "The parsed result has no array to project");
  throw new ProjectionError("array_ambiguous", `The parsed result has several arrays (${arrays.join(", ")}); pick one with 'array'`);
}

/** 참조한 필드 이름이 모두 알려진 필드인지 검사한다. 알려진 필드는 계약의 필드 목록과 행에 실제로 있는 키다. */
function checkFields(rows: unknown[], fields: readonly string[], key: string | null, rowFields: readonly string[] | undefined): void {
  if (fields.length === 0) return;
  const where = key === null ? "the parsed array" : `'${key}'`;
  if (rows.some(r => !isRow(r))) {
    throw new ProjectionError("unknown_field", `Rows of ${where} are not objects and have no fields (requested: ${fields.join(", ")})`);
  }
  if (rows.length === 0 && rowFields === undefined) return;

  const known = new Set(rowFields ?? []);
  for (const row of rows as Row[]) for (const k of Object.keys(row)) known.add(k);
  const unknown = fields.filter(f => !known.has(f));
  if (unknown.length > 0) {
    throw new ProjectionError("unknown_field", `Unknown field(s) ${unknown.map(f => `'${f}'`).join(", ")} in ${where}; known fields: ${[...known].join(", ")}`);
  }
}

function mismatch(field: string, op: string, value: unknown): ProjectionError {
  return new ProjectionError("type_mismatch", `Field '${field}' has a ${typeName(value)} value; '${op}' needs a matching type`);
}

/** 조건 하나가 행에 맞는지. 필드 값의 형이 연산과 맞지 않으면 type_mismatch를 던진다. */
function matches(row: Row, cond: WhereCondition): boolean {
  const actual = fieldOf(row, cond.field);
  switch (cond.op) {
    case "eq":
    case "ne": {
      if (cond.value === null) return (actual === undefined) === (cond.op === "eq");
      if (actual === undefined) return cond.op === "ne";
      if (typeof actual !== typeof cond.value) throw mismatch(cond.field, cond.op, actual);
      return (actual === cond.value) === (cond.op === "eq");
    }
    case "prefix":
    case "contains": {
      if (actual === undefined) return false;
      if (typeof actual !== "string") throw mismatch(cond.field, cond.op, actual);
      return cond.op === "prefix" ? actual.startsWith(cond.value) : actual.includes(cond.value);
    }
    default: {
      if (actual === undefined) return false;
      if (typeof actual !== "number") throw mismatch(cond.field, cond.op, actual);
      if (cond.op === "gt")  return actual >  cond.value;
      if (cond.op === "gte") return actual >= cond.value;
      if (cond.op === "lt")  return actual <  cond.value;
      return actual <= cond.value;
    }
  }
}

/**
 * 안정 정렬. 값이 없는 행은 방향과 관계없이 뒤에 두고 같은 값은 원래 순서를 지킨다.
 * 값의 형은 수, 문자열, 불리언 가운데 하나로 같아야 한다.
 */
function sortRows(rows: Row[], spec: SortSpec): Row[] {
  const sign  = spec.order === "desc" ? -1 : 1;
  let   kind: string | undefined;
  const keyed = rows.map((row, index) => {
    const value = fieldOf(row, spec.field);
    if (value !== undefined) {
      const t = typeof value;
      if (t !== "number" && t !== "string" && t !== "boolean") throw mismatch(spec.field, "sort_by", value);
      if (kind !== undefined && kind !== t) {
        throw new ProjectionError("type_mismatch", `Field '${spec.field}' mixes ${kind} and ${t} values; sort_by needs one type`);
      }
      kind = t;
    }
    return { row, index, value: value as number | string | boolean | undefined };
  });
  keyed.sort((a, b) => {
    if (a.value === undefined || b.value === undefined) {
      if (a.value === b.value) return a.index - b.index;
      return a.value === undefined ? 1 : -1;
    }
    if (a.value < b.value) return -sign;
    if (a.value > b.value) return sign;
    return a.index - b.index;
  });
  return keyed.map(k => k.row);
}

/** 고른 필드만 남긴 행. 프로토타입 없는 객체라 __proto__ 같은 필드 이름도 일반 속성으로 남는다. */
function selectFields(row: Row, fields: readonly string[]): Row {
  const out = Object.create(null) as Row;
  for (const f of fields) if (Object.hasOwn(row, f)) out[f] = row[f];
  return out;
}

/**
 * 결과 객체를 만든다. 대상 배열은 투영한 행으로 바꾸고, 대상이 아닌 최상위 배열은 cap을 넘으면 cap까지 자른다.
 * 프로토타입 없는 객체에 키를 옮기므로 __proto__ 같은 키도 일반 속성이다. 자른 배열의 키를 돌려준다.
 */
function buildResult(parsed: Row, key: string, rows: unknown[], cap: number): { result: Row; cut: string[] } {
  const result = Object.create(null) as Row;
  const cut: string[] = [];
  for (const [k, v] of Object.entries(parsed)) {
    if (k !== key && Array.isArray(v) && v.length > cap) {
      result[k] = v.slice(0, cap);
      cut.push(k);
    } else {
      result[k] = v;
    }
  }
  result[key] = rows;
  return { result, cut };
}

/**
 * 파싱 결과에 투영을 적용한다. 입력은 바꾸지 않는다.
 * 대상 배열이 결과 객체 안에 있으면 그 배열을 투영한 행으로 바꾸고 같은 객체에 _summary를 둔다.
 * 결과가 최상위 배열이면 투영한 배열을 그대로 돌려주며 요약은 summary로만 전한다.
 * maxItems가 0보다 크면 보이는 행을 그 수로 자르고 summary.truncated를 남긴다. 결과 객체 안의 대상이 아닌 배열도
 * 그 수로 자르고 자른 배열의 키를 summary.truncated_arrays에 남긴다.
 */
export function applyProjection(
  parsed:   unknown,
  options:  ProjectionOptions,
  shape:    ProjectionShape | undefined,
  maxItems: number,
): ProjectionOutcome {
  try {
    const { key, rows } = pickTarget(parsed, options.array, shape?.rowsKey);
    const rowFields     = key !== null && key === shape?.rowsKey ? shape.rowFields : undefined;
    const referenced    = [...(options.select ?? []), ...(options.where ?? []).map(c => c.field), ...(options.sort_by ? [options.sort_by.field] : [])];
    checkFields(rows, referenced, key, rowFields);

    let out = options.where ? (rows as Row[]).filter(r => options.where!.every(c => matches(r, c))) : rows;
    const matched = out.length;
    if (options.sort_by) out = sortRows(out as Row[], options.sort_by);

    const cap   = maxItems > 0 ? maxItems : Infinity;
    const limit = Math.min(options.limit ?? Infinity, cap);
    if (out.length > limit) out = out.slice(0, limit);
    if (options.select) out = (out as Row[]).map(r => selectFields(r, options.select!));

    const summary: ProjectionSummary = { total: rows.length, matched, shown: out.length };
    if (matched > cap && (options.limit === undefined || options.limit > cap)) summary.truncated = true;
    if (key === null) return { ok: true, parsed: out, rows: out, summary };

    const { result, cut } = buildResult(parsed as Row, key, out, cap);
    if (cut.length > 0) summary.truncated_arrays = cut;
    result._summary = summary;
    return { ok: true, parsed: result, rows: out, summary };
  } catch (err) {
    if (err instanceof ProjectionError) return { ok: false, reason: err.reason, message: err.message };
    throw err;
  }
}
