/**
 * 출력 리댁션 모듈.
 * raw stdout/stderr 문자열에서 민감 정보를 [REDACTED]로 치환한다.
 * 파싱 전 원본은 건드리지 않는다 — 리댁션은 파서 실행 후 서버 레이어에서만 호출된다.
 *
 * 정규식은 `regex-engine.ts` 를 거친다. Rust 엔진이 있으면 그것을 쓰고,
 * Rust 로 재현할 수 없는 패턴은 TypeScript 로 되돌린다.
 */

import { findAllRanges, replaceAllText, type RegexEngineOptions } from "./regex-engine.js";
import { SECRET_ASSIGNMENT_RULE, secretAssignmentRanges }       from "./secret-assignment.js";

export { SECRET_ASSIGNMENT_RULE };

export const DEFAULT_OUTPUT_REDACT_PATTERNS: string[] = [
  "sk-[A-Za-z0-9_-]{20,}",              // OpenAI/Anthropic API keys
  "ghp_[A-Za-z0-9]{30,}",              // GitHub Personal Access Token
  "gho_[A-Za-z0-9]{30,}",              // GitHub OAuth token
  "glpat-[A-Za-z0-9_-]{20,}",          // GitLab PAT
  "AKIA[0-9A-Z]{16}",                   // AWS Access Key ID
  "xox[baprs]-[A-Za-z0-9-]{10,}",      // Slack token
  "Bearer\\s+[A-Za-z0-9._-]+",         // generic Bearer header
  "://[^/\\s:@]*:[^/\\s@]+@",            // URL userinfo (scheme://user:password@host)
  /** 이름에 PASSWORD, PASSWD, SECRET, TOKEN, API_KEY, CREDENTIAL이 든 대입(KEY=value, key: value)의 값. engine/secret-assignment.ts */
  SECRET_ASSIGNMENT_RULE,
  "eyJ[A-Za-z0-9_-]{8,}\\.[A-Za-z0-9_-]{8,}\\.[A-Za-z0-9_-]{8,}", // JWT
  "-----BEGIN [A-Z ]*PRIVATE KEY-----",  // PEM private key header
];

/** 값을 통째로 가리는 필드 이름의 부분 문자열(대문자 비교). guard.secrets.env_patterns 기본값과 같다. */
export const DEFAULT_SECRET_FIELD_NAMES = ["TOKEN", "SECRET", "AUTHZ", "PASSWORD", "PASSWD", "CREDENTIAL", "API_KEY", "APIKEY", "PRIVATE_KEY"];

/**
 * 주어진 패턴들로 문자열 안의 민감정보를 [REDACTED]로 치환한다.
 * 패턴은 RegExp 리터럴 문자열로 받아 RegExp("pattern", "g")로 컴파일한다.
 *
 * @param opts 정규식 엔진이 TypeScript 로 되돌아간 사실을 받는다.
 */
export async function redact(text: string, patterns: string[], opts?: RegexEngineOptions): Promise<string> {
  if (!text || patterns.length === 0) return text;
  let result = text;
  for (const p of patterns) {
    if (p === SECRET_ASSIGNMENT_RULE) {
      const ranges = secretAssignmentRanges(result);
      if (ranges.length > 0) result = maskSpans(result, ranges);
      continue;
    }
    try {
      const replaced = await replaceAllText(p, result, "[REDACTED]", "g", true, opts);
      result = replaced.value;
    } catch {
      // Invalid regex — skip silently; the boot-time validator will warn
    }
  }
  return result;
}

/**
 * 패턴 목록을 컴파일 단계에서 검증하고, 유효하지 않은 패턴은 stderr 경고 후 제외한다.
 * 서버 기동 시 1회만 호출한다.
 */
export function validatePatterns(patterns: string[]): string[] {
  const valid: string[] = [];
  for (const p of patterns) {
    if (p === SECRET_ASSIGNMENT_RULE) { valid.push(p); continue; }
    try {
      new RegExp(p);
      valid.push(p);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`[parism] invalid redact pattern '${p}': ${msg}\n`);
    }
  }
  return valid;
}

/** 파싱 결과 안의 문자열을 한 번에 검사할 때 문자열 사이에 두는 구분자 */
const LEAF_SEPARATOR = "\n";

/** 파싱 결과 리댁션의 결과 */
export interface ParsedRedaction<T> {
  /** 가린 결과. 가린 것이 없으면 입력과 같은 참조다. */
  value: T;
  /** 가린 구간 수 */
  count: number;
}

/**
 * 파싱 결과 안의 모든 문자열(값과 객체 키)에서 민감 정보를 [REDACTED]로 바꾼다.
 *
 * 문자열마다 정규식을 따로 돌리면 행 수 × 필드 수 × 패턴 수만큼 엔진을 부른다. 그래서 문자열을
 * 줄바꿈으로 이어 패턴마다 한 번만 찾고, 찾은 구간을 각 문자열로 되돌려 가린다.
 * 구간이 두 문자열에 걸치면(값이 필드 둘로 쪼개진 경우) 두 문자열의 해당 부분을 모두 가린다.
 * ^나 $가 든 패턴은 m 플래그로 찾는다. ^와 $가 문자열 경계에서도 맞아 문자열마다 따로 찾을 때보다 덜 놓친다.
 *
 * 입력은 바꾸지 않는다. 가린 것이 있으면 바뀐 경로만 새로 만든 사본을 돌려준다.
 */
export async function redactParsedValue<T>(
  input: T, patterns: string[], opts?: RegexEngineOptions & { secretFieldNames?: readonly string[] },
): Promise<ParsedRedaction<T>> {
  /** 이름이 비밀을 뜻하는 필드(vars.DB_PASSWORD, {name: "API_TOKEN", value}의 value)는 값을 통째로 가린다. */
  const names   = (opts?.secretFieldNames ?? DEFAULT_SECRET_FIELD_NAMES).map(n => n.toUpperCase());
  const byName  = names.length > 0 ? maskSecretFields(input, names, 0) : { value: input, count: 0 };
  const value   = byName.value as T;
  const matched = await redactLeaves(value, patterns, opts);
  return { value: matched.value, count: matched.count + byName.count };
}

/** 필드 이름이 비밀을 뜻하는지 */
function secretName(name: string, names: readonly string[]): boolean {
  const upper = name.toUpperCase();
  return names.some(n => upper.includes(n));
}

const NAME_FIELDS  = ["name", "key", "Name", "Key"];
const VALUE_FIELDS = ["value", "Value"];

/** 이름이 비밀을 뜻하는 필드의 문자열 값을 [REDACTED]로 바꾼 사본. 바뀐 것이 없으면 같은 참조다. */
function maskSecretFields(value: unknown, names: readonly string[], depth: number): { value: unknown; count: number } {
  if (value === null || typeof value !== "object" || depth > MAX_REDACT_DEPTH) return { value, count: 0 };
  if (Array.isArray(value)) {
    let count = 0;
    const out = value.map(item => { const r = maskSecretFields(item, names, depth + 1); count += r.count; return r.value; });
    return count > 0 ? { value: out, count } : { value, count: 0 };
  }
  const record = value as Record<string, unknown>;
  const nameField  = NAME_FIELDS.find(f => typeof record[f] === "string");
  const valueField = VALUE_FIELDS.find(f => Object.hasOwn(record, f));
  let count = 0;
  const out = (Object.getPrototypeOf(value) === null ? Object.create(null) : {}) as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    const child = record[key];
    const leaf  = typeof child === "string";
    const keyed = leaf && secretName(key, names);
    const paired = leaf && key === valueField && nameField !== undefined && secretName(record[nameField] as string, names);
    if ((keyed || paired) && child !== "" && child !== "[REDACTED]") {
      out[key] = "[REDACTED]";
      count++;
      continue;
    }
    const r = maskSecretFields(child, names, depth + 1);
    out[key] = r.value;
    count += r.count;
  }
  return count > 0 ? { value: out, count } : { value, count: 0 };
}

async function redactLeaves<T>(value: T, patterns: string[], opts?: RegexEngineOptions): Promise<ParsedRedaction<T>> {
  if (patterns.length === 0 || value === null || typeof value !== "object") {
    if (typeof value === "string") {
      const masked = await redact(value, patterns, opts);
      return { value: masked as T, count: masked === value ? 0 : 1 };
    }
    return { value, count: 0 };
  }
  const leaves: string[] = [];
  collectStrings(value, leaves, 0);
  if (leaves.length === 0) return { value, count: 0 };

  const starts: number[] = [];
  let   offset = 0;
  for (const leaf of leaves) {
    starts.push(offset);
    offset += leaf.length + LEAF_SEPARATOR.length;
  }
  const joined = leaves.join(LEAF_SEPARATOR);

  const ranges: { start: number; end: number }[] = [];
  for (const pattern of patterns) {
    if (pattern === SECRET_ASSIGNMENT_RULE) {
      ranges.push(...secretAssignmentRanges(joined));
      continue;
    }
    try {
      const found = await findAllRanges(pattern, joined, /[\^$]/.test(pattern) ? "gm" : "g", opts);
      ranges.push(...found.value);
    } catch {
      /** 컴파일되지 않는 패턴은 기동 시 validatePatterns가 이미 알렸다. */
    }
  }
  if (ranges.length === 0) return { value, count: 0 };

  /** 문자열마다 가릴 구간을 모은다. 이분 탐색으로 구간이 시작하는 문자열을 찾는다. */
  const perLeaf = new Map<number, { start: number; end: number }[]>();
  for (const range of ranges) {
    let index = upperBound(starts, range.start) - 1;
    while (index < leaves.length && starts[index]! < range.end) {
      const leafStart = starts[index]!;
      const leafEnd   = leafStart + leaves[index]!.length;
      const start     = Math.max(range.start, leafStart) - leafStart;
      const end       = Math.min(range.end, leafEnd) - leafStart;
      if (end > start) {
        const list = perLeaf.get(index) ?? [];
        list.push({ start, end });
        perLeaf.set(index, list);
      }
      index++;
    }
  }
  if (perLeaf.size === 0) return { value, count: 0 };

  const replaced = leaves.map((leaf, index) => {
    const list = perLeaf.get(index);
    return list ? maskSpans(leaf, list) : leaf;
  });
  const cursor = { next: 0 };
  return { value: rebuild(value, replaced, cursor, 0) as T, count: ranges.length };
}

/** 리댁션이 내려가는 최대 깊이. 파서 결과는 이보다 얕다. 더 깊은 값은 문자열로 보지 않고 그대로 둔다. */
const MAX_REDACT_DEPTH = 64;

/** 문자열을 결과 순서대로 모은다. 객체는 키, 값 순서다. rebuild가 같은 순서로 되돌린다. */
function collectStrings(value: unknown, out: string[], depth: number): void {
  if (typeof value === "string") { out.push(value); return; }
  if (value === null || typeof value !== "object" || depth > MAX_REDACT_DEPTH) return;
  if (Array.isArray(value)) {
    for (const item of value) collectStrings(item, out, depth + 1);
    return;
  }
  for (const key of Object.keys(value)) {
    out.push(key);
    collectStrings((value as Record<string, unknown>)[key], out, depth + 1);
  }
}

function rebuild(value: unknown, replaced: string[], cursor: { next: number }, depth: number): unknown {
  if (typeof value === "string") return replaced[cursor.next++];
  if (value === null || typeof value !== "object" || depth > MAX_REDACT_DEPTH) return value;
  if (Array.isArray(value)) return value.map(item => rebuild(item, replaced, cursor, depth + 1));
  const out = (Object.getPrototypeOf(value) === null ? Object.create(null) : {}) as Record<string, unknown>;
  for (const key of Object.keys(value)) {
    let name = replaced[cursor.next++]!;
    /** 가린 키가 다른 키와 겹치면 값을 잃지 않게 번호를 붙인다. */
    for (let n = 2; Object.hasOwn(out, name); n++) name = `${replaced[cursor.next - 1]}#${n}`;
    out[name] = rebuild((value as Record<string, unknown>)[key], replaced, cursor, depth + 1);
  }
  return out;
}

/** 겹치거나 맞닿은 구간을 하나로 합쳐 [REDACTED]로 바꾼다 */
function maskSpans(text: string, spans: { start: number; end: number }[]): string {
  const sorted = [...spans].sort((a, b) => a.start - b.start);
  const merged: { start: number; end: number }[] = [];
  for (const span of sorted) {
    const last = merged[merged.length - 1];
    if (last && span.start <= last.end) last.end = Math.max(last.end, span.end);
    else merged.push({ ...span });
  }
  let out  = "";
  let prev = 0;
  for (const span of merged) {
    out += text.slice(prev, span.start) + "[REDACTED]";
    prev = span.end;
  }
  return out + text.slice(prev);
}

/** sorted에서 x보다 큰 첫 원소의 위치 */
function upperBound(sorted: readonly number[], x: number): number {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (sorted[mid]! <= x) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}
