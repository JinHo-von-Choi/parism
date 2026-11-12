/**
 * 파이프-투영 컴파일러.
 *
 * `ps aux | grep node | head -n 5`의 `grep`, `head` 같은 뒤 단계를 자식 프로세스로 띄우지 않고
 * Parism 안에서 처리한다. 두 방식이 있다.
 *
 *   행 모드   첫 명령의 파싱 결과에 행 배열이 있고 모든 단계를 행에 옮길 수 있으면,
 *             단계를 순서대로 행 배열에 적용한다(ProjectionStage). 결과는 구조화된 행이다.
 *   글자 모드 그 밖에는 첫 명령의 표준 출력 줄에 단계를 순서대로 적용한다. 결과는 셸 파이프와 같은 글자다.
 *
 * 정규식은 regex-engine을 거친다. Rust 엔진이 있으면 역추적 없는 선형 시간으로 찾는다.
 *
 * 지원하는 단계:
 *   grep [-i] [-v] [-E|-F|-G] [-w] [-x] [-c] [-m N] [-e PAT]... [PAT]
 *   head [-n N | -N]           tail [-n N | -N | -n +N]
 *   wc [-l | -w | -c | -m]     sort [-r] [-n] [-u] [-f] [-t SEP] [-k N[,M] | -k 필드]
 *   uniq [-c] [-d] [-u]        cut (-f LIST [-d SEP] | -c LIST)   (uniq, cut은 글자 모드만)
 *
 * 작성자: 최진호
 * 작성일: 2026-11-12
 */

import { findAllRanges, type RegexEngineOptions } from "./regex-engine.js";

export type FilterSpec =
  | { kind: "grep"; pattern: string; flags: string; invert: boolean; count: boolean; maxCount?: number; lineMode: "any" | "word" | "line" }
  | { kind: "head"; count: number }
  | { kind: "tail"; count: number; fromLine?: number }
  | { kind: "wc"; mode: "lines" | "words" | "bytes" | "chars" | "all" }
  | { kind: "sort"; reverse: boolean; numeric: boolean; unique: boolean; foldCase: boolean; separator?: string;
      key?: { field: number; endField?: number } | { name: string } }
  | { kind: "uniq"; count: boolean; onlyDuplicates: boolean; onlyUnique: boolean }
  | { kind: "cut"; separator: string; fields?: Range[]; chars?: Range[] };

interface Range { from: number; to: number }

/** 행 배열에 순서대로 적용하는 투영 단계 */
export type ProjectionStage =
  | { op: "where_regex"; pattern: string; flags: string; negate: boolean }
  | { op: "limit"; count: number; from: "start" | "end" }
  | { op: "skip"; count: number }
  | { op: "aggregate"; spec: { count: true } }
  | { op: "sort_by"; field: string; order: "asc" | "desc"; numeric: boolean; unique: boolean };

export interface FilterError {
  ok:      false;
  stage:   string;
  message: string;
  hint:    string;
}

export const SUPPORTED_FILTERS = ["grep", "head", "tail", "wc", "sort", "uniq", "cut"] as const;

const UNSUPPORTED_HINT =
  `pipe stages are run inside Parism, not by a shell. Supported: ${SUPPORTED_FILTERS.join(", ")}. ` +
  "For other processing run the first command alone, keep the result (contract_version \"next\", retain true) and filter it with query_result (where, sort_by, limit, select, aggregate)";

function fail(stage: string[], message: string): FilterError {
  return { ok: false, stage: stage.join(" "), message, hint: UNSUPPORTED_HINT };
}

/** 정수 인자. 형식이 아니면 undefined */
function int(text: string | undefined): number | undefined {
  if (text === undefined || !/^[0-9]+$/.test(text)) return undefined;
  return Number(text);
}

// ── 단계 해석 ──────────────────────────────────────────────────────────────

/** 단계 argv 하나를 해석한다 */
export function parseFilter(argv: string[]): { ok: true; spec: FilterSpec } | FilterError {
  const [name, ...args] = argv;
  switch (name) {
    case "grep":  case "egrep": case "fgrep": return parseGrep(name, args, argv);
    case "head":  return parseHeadTail("head", args, argv);
    case "tail":  return parseHeadTail("tail", args, argv);
    case "wc":    return parseWc(args, argv);
    case "sort":  return parseSort(args, argv);
    case "uniq":  return parseUniq(args, argv);
    case "cut":   return parseCut(args, argv);
    default:      return fail(argv, `'${name}' is not a supported pipe stage`);
  }
}

function parseGrep(name: string, args: string[], argv: string[]): { ok: true; spec: FilterSpec } | FilterError {
  let syntax: "basic" | "extended" | "fixed" = name === "egrep" ? "extended" : name === "fgrep" ? "fixed" : "basic";
  let ignoreCase = false;
  let invert     = false;
  let count      = false;
  let lineMode: "any" | "word" | "line" = "any";
  let maxCount: number | undefined;
  const patterns: string[] = [];
  const positionals: string[] = [];
  let endOfFlags = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (endOfFlags || !arg.startsWith("-") || arg === "-") { positionals.push(arg); continue; }
    if (arg === "--") { endOfFlags = true; continue; }
    if (arg === "-e" || arg === "--regexp") {
      const value = args[++i];
      if (value === undefined) return fail(argv, `${arg} needs a pattern`);
      patterns.push(value);
      continue;
    }
    if (arg.startsWith("--regexp=")) { patterns.push(arg.slice(9)); continue; }
    if (arg === "-m" || arg === "--max-count") {
      maxCount = int(args[++i]);
      if (maxCount === undefined) return fail(argv, `${arg} needs a number`);
      continue;
    }
    if (arg.startsWith("--max-count=")) {
      maxCount = int(arg.slice(12));
      if (maxCount === undefined) return fail(argv, "--max-count needs a number");
      continue;
    }
    const long: Record<string, () => void> = {
      "--ignore-case": () => { ignoreCase = true; }, "--invert-match": () => { invert = true; },
      "--count": () => { count = true; }, "--word-regexp": () => { lineMode = "word"; },
      "--line-regexp": () => { lineMode = "line"; }, "--extended-regexp": () => { syntax = "extended"; },
      "--fixed-strings": () => { syntax = "fixed"; }, "--basic-regexp": () => { syntax = "basic"; },
    };
    if (arg.startsWith("--")) {
      const set = long[arg];
      if (!set) return fail(argv, `grep option '${arg}' is not supported in a pipe stage`);
      set();
      continue;
    }
    /** 짧은 플래그 묶음(-iv, -m5, -e패턴) */
    for (let j = 1; j < arg.length; j++) {
      const flag = arg[j]!;
      if (flag === "e" || flag === "m") {
        const attached = arg.slice(j + 1);
        const value    = attached !== "" ? attached : args[++i];
        if (value === undefined) return fail(argv, `-${flag} needs a value`);
        if (flag === "e") patterns.push(value);
        else {
          maxCount = int(value);
          if (maxCount === undefined) return fail(argv, "-m needs a number");
        }
        break;
      }
      switch (flag) {
        case "i": case "y": ignoreCase = true; break;
        case "v": invert = true; break;
        case "c": count = true; break;
        case "w": lineMode = "word"; break;
        case "x": lineMode = "line"; break;
        case "E": syntax = "extended"; break;
        case "F": syntax = "fixed"; break;
        case "G": syntax = "basic"; break;
        case "s": case "h": case "a": case "I": break;
        default:  return fail(argv, `grep option '-${flag}' is not supported in a pipe stage`);
      }
    }
  }
  if (patterns.length === 0) {
    const first = positionals.shift();
    if (first === undefined) return fail(argv, "grep needs a pattern");
    patterns.push(first);
  }
  if (positionals.length > 0) return fail(argv, `grep in a pipe reads the previous output, not files (${positionals.join(" ")})`);

  const sources = patterns.flatMap(p => p.split("\n")).map(p => toJsRegex(p, syntax));
  let source = sources.length === 1 ? sources[0]! : sources.map(s => `(?:${s})`).join("|");
  if (lineMode === "word") source = `\\b(?:${source})\\b`;
  if (lineMode === "line") source = `^(?:${source})$`;
  try {
    new RegExp(source, ignoreCase ? "i" : "");
  } catch (err) {
    return fail(argv, `invalid grep pattern: ${(err as Error).message}`);
  }
  return { ok: true, spec: { kind: "grep", pattern: source, flags: ignoreCase ? "i" : "", invert, count, lineMode, ...(maxCount !== undefined && { maxCount }) } };
}

const POSIX_CLASSES: Record<string, string> = {
  alpha: "A-Za-z", digit: "0-9", alnum: "A-Za-z0-9", upper: "A-Z", lower: "a-z", space: "\\s",
  blank: " \\t", punct: "!-\\/:-@\\[-`{-~", xdigit: "0-9A-Fa-f", word: "A-Za-z0-9_", cntrl: "\\x00-\\x1f\\x7f",
  print: "\\x20-\\x7e", graph: "\\x21-\\x7e",
};

/**
 * grep 패턴을 JavaScript 정규식 소스로 바꾼다.
 * 기본 정규식(BRE)은 \( \) \{ \} \| \+ \?가 특수 문자이고 맨 글자 ( ) { } | + ?는 글자 그대로다.
 * \< \>는 단어 경계, [[:alpha:]] 같은 POSIX 문자 부류는 같은 범위로 바꾼다.
 */
export function toJsRegex(pattern: string, syntax: "basic" | "extended" | "fixed"): string {
  if (syntax === "fixed") return pattern.replace(/[.*+?^${}()|[\]\\/]/g, ch => `\\${ch}`);
  let out = "";
  let inClass = false;
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i]!;
    if (inClass) {
      if (ch === "[" && pattern[i + 1] === ":") {
        const close = pattern.indexOf(":]", i + 2);
        const name  = close > 0 ? pattern.slice(i + 2, close) : "";
        if (POSIX_CLASSES[name] !== undefined) { out += POSIX_CLASSES[name]; i = close + 1; continue; }
      }
      if (ch === "]" && !out.endsWith("[") && !out.endsWith("[^")) inClass = false;
      out += ch === "\\" ? "\\\\" : ch;
      continue;
    }
    if (ch === "[") { inClass = true; out += ch; if (pattern[i + 1] === "^") { out += "^"; i++; } if (pattern[i + 1] === "]") { out += "\\]"; i++; } continue; }
    if (ch === "\\") {
      const next = pattern[i + 1];
      i++;
      if (next === undefined) { out += "\\\\"; break; }
      if (next === "<" || next === ">") { out += "\\b"; continue; }
      if (syntax === "basic" && "(){}|+?".includes(next)) { out += next; continue; }
      out += `\\${next}`;
      continue;
    }
    if (syntax === "basic" && "(){}|+?".includes(ch)) { out += `\\${ch}`; continue; }
    if (ch === "*" && (out === "" || out.endsWith("^") || out.endsWith("("))) { out += "\\*"; continue; }
    if (ch === "/") { out += "\\/"; continue; }
    out += ch;
  }
  return out;
}

function parseHeadTail(kind: "head" | "tail", args: string[], argv: string[]): { ok: true; spec: FilterSpec } | FilterError {
  let count = 10;
  let fromLine: number | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    let value: string | undefined;
    if (arg === "-n" || arg === "--lines") value = args[++i];
    else if (arg.startsWith("--lines=")) value = arg.slice(8);
    else if (/^-n.+/.test(arg)) value = arg.slice(2);
    else if (/^-[0-9]+$/.test(arg)) value = arg.slice(1);
    else if (arg === "-q" || arg === "--quiet" || arg === "--silent") continue;
    else return fail(argv, `${kind} option '${arg}' is not supported in a pipe stage`);
    if (value === undefined) return fail(argv, `${arg} needs a number`);
    if (kind === "tail" && value.startsWith("+") && int(value.slice(1)) !== undefined) {
      fromLine = Math.max(1, int(value.slice(1))!);
      continue;
    }
    const n = int(value);
    if (n === undefined) return fail(argv, `${kind} line count '${value}' is not supported in a pipe stage`);
    count = n;
  }
  if (kind === "head") return { ok: true, spec: { kind, count } };
  return { ok: true, spec: { kind, count, ...(fromLine !== undefined && { fromLine }) } };
}

function parseWc(args: string[], argv: string[]): { ok: true; spec: FilterSpec } | FilterError {
  const modes: Record<string, "lines" | "words" | "bytes" | "chars"> = {
    "-l": "lines", "--lines": "lines", "-w": "words", "--words": "words", "-c": "bytes", "--bytes": "bytes", "-m": "chars", "--chars": "chars",
  };
  if (args.length === 0) return { ok: true, spec: { kind: "wc", mode: "all" } };
  if (args.length === 1 && modes[args[0]!]) return { ok: true, spec: { kind: "wc", mode: modes[args[0]!]! } };
  return fail(argv, "wc in a pipe takes one of -l, -w, -c, -m");
}

function parseSort(args: string[], argv: string[]): { ok: true; spec: FilterSpec } | FilterError {
  const spec: Extract<FilterSpec, { kind: "sort" }> = { kind: "sort", reverse: false, numeric: false, unique: false, foldCase: false };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "-k" || arg === "--key" || arg.startsWith("-k") || arg.startsWith("--key=")) {
      const raw = arg === "-k" || arg === "--key" ? args[++i] : arg.startsWith("--key=") ? arg.slice(6) : arg.slice(2);
      if (raw === undefined || raw === "") return fail(argv, "-k needs a key");
      const m = /^([0-9]+)([a-z]*)(?:,([0-9]+)([a-z]*))?$/.exec(raw);
      if (m) {
        spec.key = { field: Number(m[1]), ...(m[3] !== undefined && { endField: Number(m[3]) }) };
        for (const opt of (m[2] ?? "") + (m[4] ?? "")) {
          if (opt === "n") spec.numeric = true;
          else if (opt === "r") spec.reverse = true;
          else if (opt === "f") spec.foldCase = true;
          else return fail(argv, `sort key option '${opt}' is not supported in a pipe stage`);
        }
      } else if (/^[A-Za-z_][A-Za-z0-9_.-]*$/.test(raw)) {
        spec.key = { name: raw };
      } else {
        return fail(argv, `sort key '${raw}' is not supported in a pipe stage`);
      }
      continue;
    }
    if (arg === "-t" || arg.startsWith("-t") || arg.startsWith("--field-separator=")) {
      const sep = arg === "-t" ? args[++i] : arg.startsWith("-t") ? arg.slice(2) : arg.slice(18);
      if (sep === undefined || sep.length !== 1) return fail(argv, "-t needs one character");
      spec.separator = sep;
      continue;
    }
    const long: Record<string, keyof typeof spec> = { "--reverse": "reverse", "--numeric-sort": "numeric", "--unique": "unique", "--ignore-case": "foldCase" };
    if (arg.startsWith("--")) {
      const key = long[arg];
      if (!key) return fail(argv, `sort option '${arg}' is not supported in a pipe stage`);
      (spec as Record<string, unknown>)[key] = true;
      continue;
    }
    if (!arg.startsWith("-")) return fail(argv, `sort in a pipe reads the previous output, not files (${arg})`);
    for (const flag of arg.slice(1)) {
      if (flag === "r") spec.reverse = true;
      else if (flag === "n") spec.numeric = true;
      else if (flag === "u") spec.unique = true;
      else if (flag === "f") spec.foldCase = true;
      else if (flag === "s" || flag === "b") continue;
      else return fail(argv, `sort option '-${flag}' is not supported in a pipe stage`);
    }
  }
  return { ok: true, spec };
}

function parseUniq(args: string[], argv: string[]): { ok: true; spec: FilterSpec } | FilterError {
  const spec = { kind: "uniq" as const, count: false, onlyDuplicates: false, onlyUnique: false };
  for (const arg of args) {
    if (arg === "-c" || arg === "--count") spec.count = true;
    else if (arg === "-d" || arg === "--repeated") spec.onlyDuplicates = true;
    else if (arg === "-u" || arg === "--unique") spec.onlyUnique = true;
    else if (/^-[cdu]+$/.test(arg)) {
      for (const f of arg.slice(1)) {
        if (f === "c") spec.count = true;
        if (f === "d") spec.onlyDuplicates = true;
        if (f === "u") spec.onlyUnique = true;
      }
    } else return fail(argv, `uniq option '${arg}' is not supported in a pipe stage`);
  }
  return { ok: true, spec };
}

function parseRanges(list: string): Range[] | undefined {
  const out: Range[] = [];
  for (const part of list.split(",")) {
    const m = /^([0-9]*)(-?)([0-9]*)$/.exec(part);
    if (!m || (m[1] === "" && m[3] === "")) return undefined;
    const from = m[1] === "" ? 1 : Number(m[1]);
    const to   = m[2] === "" ? from : m[3] === "" ? Infinity : Number(m[3]);
    if (from < 1 || to < from) return undefined;
    out.push({ from, to });
  }
  return out;
}

function parseCut(args: string[], argv: string[]): { ok: true; spec: FilterSpec } | FilterError {
  let separator = "\t";
  let fields: Range[] | undefined;
  let chars:  Range[] | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    const take = (flag: string): string | undefined => (arg === flag ? args[++i] : arg.slice(flag.length));
    if (arg.startsWith("-d")) {
      const value = take("-d");
      if (value === undefined || value.length !== 1) return fail(argv, "-d needs one character");
      separator = value;
    } else if (arg.startsWith("-f")) {
      fields = parseRanges(take("-f") ?? "");
      if (!fields) return fail(argv, "-f needs a field list such as 1,3-4");
    } else if (arg.startsWith("-c")) {
      chars = parseRanges(take("-c") ?? "");
      if (!chars) return fail(argv, "-c needs a character list such as 1-10");
    } else {
      return fail(argv, `cut option '${arg}' is not supported in a pipe stage`);
    }
  }
  if (!fields && !chars) return fail(argv, "cut needs -f or -c");
  return { ok: true, spec: { kind: "cut", separator, ...(fields && { fields }), ...(chars && { chars }) } };
}

/** 파이프 뒤 단계 전체를 해석한다 */
export function parsePipeline(stages: string[][]): { ok: true; specs: FilterSpec[] } | FilterError {
  const specs: FilterSpec[] = [];
  for (const stage of stages) {
    const parsed = parseFilter(stage);
    if (!parsed.ok) return parsed;
    specs.push(parsed.spec);
  }
  return { ok: true, specs };
}

// ── 행 모드 ────────────────────────────────────────────────────────────────

/**
 * 단계를 행 배열 투영으로 옮긴다. 행에 옮길 수 없는 단계가 하나라도 있으면 undefined를 돌려준다.
 * fields는 행이 가진 필드 이름이다. sort -k 필드는 이 안에 있어야 한다.
 */
export function toProjectionStages(specs: readonly FilterSpec[], fields: ReadonlySet<string>): ProjectionStage[] | undefined {
  const out: ProjectionStage[] = [];
  for (const [index, spec] of specs.entries()) {
    const last = index === specs.length - 1;
    switch (spec.kind) {
      case "grep":
        if (spec.lineMode === "line" || (spec.count && !last)) return undefined;
        out.push({ op: "where_regex", pattern: spec.pattern, flags: spec.flags, negate: spec.invert });
        if (spec.maxCount !== undefined) out.push({ op: "limit", count: spec.maxCount, from: "start" });
        if (spec.count) out.push({ op: "aggregate", spec: { count: true } });
        break;
      case "head":
        out.push({ op: "limit", count: spec.count, from: "start" });
        break;
      case "tail":
        out.push(spec.fromLine !== undefined ? { op: "skip", count: spec.fromLine - 1 } : { op: "limit", count: spec.count, from: "end" });
        break;
      case "wc":
        if (spec.mode !== "lines" || !last) return undefined;
        out.push({ op: "aggregate", spec: { count: true } });
        break;
      case "sort":
        if (!spec.key || !("name" in spec.key) || !fields.has(spec.key.name) || spec.separator !== undefined || spec.foldCase) return undefined;
        out.push({ op: "sort_by", field: spec.key.name, order: spec.reverse ? "desc" : "asc", numeric: spec.numeric, unique: spec.unique });
        break;
      default:
        return undefined;
    }
  }
  return out;
}

type Row = Record<string, unknown>;

/** 행의 원시 값(문자열, 수, 불리언)을 공백으로 이은 글자. 행 모드의 grep이 이 글자를 본다. */
export function rowText(row: unknown, depth = 0): string {
  if (row === null || row === undefined) return "";
  if (typeof row === "string") return row.replace(/\n/g, " ");
  if (typeof row === "number" || typeof row === "boolean") return String(row);
  if (typeof row !== "object" || depth > 4) return "";
  const parts = Array.isArray(row) ? row.map(v => rowText(v, depth + 1)) : Object.values(row).map(v => rowText(v, depth + 1));
  return parts.filter(p => p !== "").join(" ");
}

/** 행 모드 적용 결과 */
export interface StagesOutcome {
  rows:     unknown[];
  /** aggregate 단계가 있으면 센 행 수 */
  count?:   number;
  /** 단계에 들어온 행 수 */
  total:    number;
  /** 거르는 단계(grep)를 통과한 행 수. head, tail, 건너뛰기로 자르기 전이다. */
  matched:  number;
}

/** 투영 단계를 행 배열에 순서대로 적용한다. 입력 배열은 바꾸지 않는다. */
export async function applyStages(rows: readonly unknown[], stages: readonly ProjectionStage[], opts?: RegexEngineOptions): Promise<StagesOutcome> {
  let current = [...rows];
  let count: number | undefined;
  let matched = rows.length;
  for (const stage of stages) {
    switch (stage.op) {
      case "where_regex": {
        const hits = await matchingLines(current.map(r => rowText(r)), stage.pattern, stage.flags, opts);
        current = current.filter((_, i) => hits.has(i) !== stage.negate);
        matched = current.length;
        break;
      }
      case "limit":
        current = stage.from === "start" ? current.slice(0, stage.count) : current.slice(Math.max(0, current.length - stage.count));
        break;
      case "skip":
        current = current.slice(stage.count);
        break;
      case "aggregate":
        count = current.length;
        break;
      case "sort_by":
        current = sortRows(current, stage);
        break;
    }
  }
  return { rows: current, total: rows.length, matched, ...(count !== undefined && { count }) };
}

function sortRows(rows: unknown[], stage: Extract<ProjectionStage, { op: "sort_by" }>): unknown[] {
  const sign  = stage.order === "desc" ? -1 : 1;
  const keyOf = (row: unknown): string | number | undefined => {
    if (row === null || typeof row !== "object") return undefined;
    const value = (row as Row)[stage.field];
    if (value === null || value === undefined) return undefined;
    if (stage.numeric) return typeof value === "number" ? value : leadingNumber(String(value));
    return typeof value === "number" ? value : String(value);
  };
  const keyed = rows.map((row, index) => ({ row, index, key: keyOf(row) }));
  keyed.sort((a, b) => {
    if (a.key === undefined || b.key === undefined) return a.key === b.key ? a.index - b.index : a.key === undefined ? 1 : -1;
    if (a.key < b.key) return -sign;
    if (a.key > b.key) return sign;
    return a.index - b.index;
  });
  const sorted = keyed.map(k => k.row);
  if (!stage.unique) return sorted;
  const seen = new Set<string>();
  return keyed.filter(k => {
    const id = JSON.stringify(k.key ?? null);
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  }).map(k => k.row);
}

// ── 글자 모드 ──────────────────────────────────────────────────────────────

/** 줄 배열과 끝 줄바꿈 여부 */
function splitLines(text: string): string[] {
  if (text === "") return [];
  const lines = text.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

function joinLines(lines: readonly string[]): string {
  return lines.length === 0 ? "" : lines.join("\n") + "\n";
}

/**
 * 패턴에 맞는 줄의 번호. 줄을 이어 패턴을 한 번만 찾고, 한 줄 안에서 끝나는 일치만 그 줄의 일치로 센다.
 * 빈 글자에 맞을 수 있는 패턴(예: ^$, x*)은 엔진이 빈 일치를 돌려주지 않으므로 줄마다 JavaScript로 검사한다.
 */
export async function matchingLines(lines: readonly string[], pattern: string, flags: string, opts?: RegexEngineOptions): Promise<Set<number>> {
  const hits = new Set<number>();
  const probe = new RegExp(pattern, flags);
  if (probe.test("")) {
    lines.forEach((line, i) => { if (probe.test(line)) hits.add(i); });
    return hits;
  }
  const starts: number[] = [];
  let offset = 0;
  for (const line of lines) {
    starts.push(offset);
    offset += line.length + 1;
  }
  /** m 플래그는 ^와 $에만 영향을 준다. 둘이 없으면 붙이지 않는다(엔진마다 줄 끝 문자 해석이 달라 TypeScript로 되돌아간다). */
  const lineFlag = /[\^$]/.test(pattern) ? "m" : "";
  const found = await findAllRanges(pattern, lines.join("\n"), `g${flags}${lineFlag}`, opts);
  for (const range of found.value) {
    let lo = 0;
    let hi = starts.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (starts[mid]! <= range.start) lo = mid + 1;
      else hi = mid;
    }
    const index = lo - 1;
    if (index >= 0 && range.end <= starts[index]! + lines[index]!.length) hits.add(index);
  }
  return hits;
}

/** 글자 맨 앞의 수. sort -n과 같이 앞 공백을 건너뛰고 수가 아니면 0이다. */
function leadingNumber(text: string): number {
  const m = /^\s*([-+]?[0-9]*\.?[0-9]+)/.exec(text);
  return m ? Number(m[1]) : 0;
}

/** sort -k의 필드. 구분자가 없으면 공백 덩어리를 경계로 하고 앞 공백은 필드에 붙는다(GNU sort와 같다). */
function sortKey(line: string, spec: Extract<FilterSpec, { kind: "sort" }>): string {
  if (!spec.key || "name" in spec.key) return line;
  const fields = spec.separator !== undefined ? line.split(spec.separator) : line.match(/\s*\S+/g) ?? [];
  const from   = spec.key.field - 1;
  const to     = spec.key.endField !== undefined ? spec.key.endField : fields.length;
  return fields.slice(from, to).join(spec.separator ?? "");
}

function sortLines(lines: string[], spec: Extract<FilterSpec, { kind: "sort" }>): string[] {
  const sign = spec.reverse ? -1 : 1;
  const norm = (s: string) => (spec.foldCase ? s.toUpperCase() : s);
  const cmp  = (a: string, b: string): number => {
    const ka = sortKey(a, spec);
    const kb = sortKey(b, spec);
    if (spec.numeric) {
      const d = leadingNumber(ka) - leadingNumber(kb);
      if (d !== 0) return d;
    } else {
      const x = norm(ka);
      const y = norm(kb);
      if (x !== y) return x < y ? -1 : 1;
    }
    if (spec.unique) return 0;
    return a === b ? 0 : a < b ? -1 : 1;
  };
  const sorted = [...lines].sort((a, b) => sign * cmp(a, b));
  if (!spec.unique) return sorted;
  return sorted.filter((line, i) => i === 0 || cmp(sorted[i - 1]!, line) !== 0);
}

function uniqLines(lines: string[], spec: Extract<FilterSpec, { kind: "uniq" }>): string[] {
  const groups: { line: string; n: number }[] = [];
  for (const line of lines) {
    const last = groups[groups.length - 1];
    if (last && last.line === line) last.n++;
    else groups.push({ line, n: 1 });
  }
  return groups
    .filter(g => (!spec.onlyDuplicates || g.n > 1) && (!spec.onlyUnique || g.n === 1))
    .map(g => (spec.count ? `${String(g.n).padStart(7)} ${g.line}` : g.line));
}

function pick<T>(items: readonly T[], ranges: readonly Range[]): T[] {
  return items.filter((_, i) => ranges.some(r => i + 1 >= r.from && i + 1 <= r.to));
}

function cutLines(lines: string[], spec: Extract<FilterSpec, { kind: "cut" }>): string[] {
  if (spec.chars) return lines.map(line => pick([...line], spec.chars!).join(""));
  return lines.map(line => (line.includes(spec.separator) ? pick(line.split(spec.separator), spec.fields!).join(spec.separator) : line));
}

function wcText(text: string, mode: Extract<FilterSpec, { kind: "wc" }>["mode"]): string {
  const lines = (text.match(/\n/g) ?? []).length;
  const words = (text.match(/\S+/g) ?? []).length;
  const bytes = Buffer.byteLength(text, "utf8");
  if (mode === "lines") return `${lines}\n`;
  if (mode === "words") return `${words}\n`;
  if (mode === "bytes") return `${bytes}\n`;
  if (mode === "chars") return `${[...text].length}\n`;
  return `${String(lines).padStart(7)} ${String(words).padStart(7)} ${String(bytes).padStart(7)}\n`;
}

/** 단계를 표준 출력 글자에 순서대로 적용한다 */
export async function applyTextFilters(text: string, specs: readonly FilterSpec[], opts?: RegexEngineOptions): Promise<string> {
  let current = text;
  for (const spec of specs) {
    const lines = splitLines(current);
    switch (spec.kind) {
      case "grep": {
        const hits = await matchingLines(lines, spec.pattern, spec.flags, opts);
        let kept   = lines.filter((_, i) => hits.has(i) !== spec.invert);
        if (spec.maxCount !== undefined) kept = kept.slice(0, spec.maxCount);
        current = spec.count ? `${kept.length}\n` : joinLines(kept);
        break;
      }
      case "head":
        current = joinLines(lines.slice(0, spec.count));
        break;
      case "tail":
        current = joinLines(spec.fromLine !== undefined ? lines.slice(spec.fromLine - 1) : lines.slice(Math.max(0, lines.length - spec.count)));
        break;
      case "wc":
        current = wcText(current, spec.mode);
        break;
      case "sort":
        current = joinLines(sortLines(lines, spec));
        break;
      case "uniq":
        current = joinLines(uniqLines(lines, spec));
        break;
      case "cut":
        current = joinLines(cutLines(lines, spec));
        break;
    }
  }
  return current;
}
