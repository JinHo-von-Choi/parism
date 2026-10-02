import { UnrecognizedOutputError, type ParseContext } from "../registry.js";

export interface GrepMatch {
  file:         string;
  line:         number;
  text:         string;
  /** -b로 표시한 바이트 오프셋 */
  byte_offset?: number;
  /** -A/-B/-C로 함께 나온 문맥 줄이면 true */
  context?:     true;
}

export interface GrepSummary {
  total:     number;
  shown:     number;
  truncated: boolean;
}

/** 값을 받는 짧은 옵션 글자. 값이 붙어 있지 않으면 다음 인자가 값이다. */
const SHORT_VALUE_FLAGS = new Set(["A", "B", "C", "m", "e", "f", "d", "D"]);

/** 값을 받는 긴 옵션. "=" 없이 쓰면 다음 인자가 값이다. */
const LONG_VALUE_FLAGS = new Set([
  "--after-context", "--before-context", "--context", "--max-count", "--regexp", "--file",
  "--devices", "--directories", "--include", "--exclude", "--exclude-dir", "--exclude-from",
  "--label", "--binary-files", "--group-separator",
]);

/** 패턴을 지정하는 옵션. 하나라도 있으면 첫 피연산자도 파일이다. */
const PATTERN_FLAGS = new Set(["e", "f", "--regexp", "--file"]);

/** 문맥 줄을 내는 옵션 */
const CONTEXT_LONGS = new Set(["--after-context", "--before-context", "--context"]);

/** 출력 줄의 짜임을 정하는 인자 분석 결과 */
interface GrepPlan {
  /** list: 파일 이름만(-l, -L), count: 파일별 개수(-c), lines: 일치 줄 */
  kind:        "list" | "count" | "lines";
  /** 파일 이름 열이 있는지. infer는 -r에 피연산자 하나라서 출력으로 가려야 한다. */
  showName:    boolean | "infer";
  /** 파일 피연산자(패턴 제외) */
  files:       string[];
  recursive:   boolean;
  lineNumbers: boolean;
  byteOffset:  boolean;
  initialTab:  boolean;
  context:     boolean;
  onlyMatch:   boolean;
  quiet:       boolean;
  nullSep:     boolean;
}

/** 재귀를 켜는 긴 옵션 */
const RECURSIVE_LONGS = new Set(["--recursive", "--dereference-recursive"]);

/**
 * 플래그와 파일 인자 수로 grep 출력 형식을 정한다. 옵션 값은 피연산자로 세지 않는다.
 * 재귀 여부는 -r, -R, -d recurse(--directories=recurse)와 -d read, skip 가운데 마지막 것이 정한다(GNU grep과 같다).
 */
function analyze(args: string[]): GrepPlan {
  const shorts:   string[] = [];
  const longs:    string[] = [];
  const operands: string[] = [];
  let   patternGiven       = false;
  let   numeric            = false;
  let   recursive          = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--") { operands.push(...args.slice(i + 1)); break; }
    if (a === "-" || !a.startsWith("-")) { operands.push(a); continue; }
    if (a.startsWith("--")) {
      const eq   = a.indexOf("=");
      const name = eq >= 0 ? a.slice(0, eq) : a;
      longs.push(name);
      if (PATTERN_FLAGS.has(name)) patternGiven = true;
      if (RECURSIVE_LONGS.has(name)) recursive = true;
      if (name === "--directories") recursive = (eq >= 0 ? a.slice(eq + 1) : args[i + 1]) === "recurse";
      if (eq < 0 && LONG_VALUE_FLAGS.has(name)) i++;
      continue;
    }
    if (/^-[0-9]+$/.test(a)) { numeric = true; continue; }
    for (let j = 1; j < a.length; j++) {
      const c = a[j]!;
      shorts.push(c);
      if (c === "r" || c === "R") recursive = true;
      if (!SHORT_VALUE_FLAGS.has(c)) continue;
      if (PATTERN_FLAGS.has(c)) patternGiven = true;
      if (c === "d") recursive = (j < a.length - 1 ? a.slice(j + 1) : args[i + 1]) === "recurse";
      if (j === a.length - 1) i++;
      break;
    }
  }
  const has       = (c: string, long: string): boolean => shorts.includes(c) || longs.includes(long);
  const files     = patternGiven ? operands : operands.slice(1);
  const forced    = has("H", "--with-filename");
  const hidden    = has("h", "--no-filename");

  const kind     = has("l", "--files-with-matches") || has("L", "--files-without-match") ? "list" : has("c", "--count") ? "count" : "lines";
  const showName = hidden ? false : forced || files.length > 1 ? true : recursive ? (files.length === 1 ? "infer" : true) : false;

  return {
    kind, showName, files, recursive,
    lineNumbers: has("n", "--line-number"),
    byteOffset:  has("b", "--byte-offset"),
    initialTab:  has("T", "--initial-tab"),
    context:     numeric || shorts.some(c => "ABC".includes(c) || /[0-9]/.test(c)) || longs.some(l => CONTEXT_LONGS.has(l)),
    onlyMatch:   has("o", "--only-matching"),
    quiet:       has("q", "--quiet") || longs.includes("--silent"),
    nullSep:     has("Z", "--null"),
  };
}

/**
 * 파서가 해석할 수 있는 조합인지 판정한다.
 * 문맥 줄(-A/-B/-C/-NUM)은 일치 줄과 구분하려면 줄 번호(-n)가 있어야 하고, -o/-c/-l/-L/-q와는 함께 쓰지 않는다.
 * NUL 구분(-Z)은 파일 목록(-l, -L)에만 받는다.
 */
export function supportsGrep(args: string[]): boolean {
  const plan = analyze(args);
  if (plan.context && (!plan.lineNumbers || plan.onlyMatch || plan.quiet || plan.kind !== "lines")) return false;
  if (plan.nullSep && plan.kind !== "list") return false;
  return true;
}

/** 번호 열(앞 공백이 붙을 수 있다)을 정규식 조각으로 만든다. */
const NUM = "\\s*(\\d+)";

/** 줄 짜임에 맞는 정규식. sep는 일치 줄 ':' 또는 문맥 줄 '-'이다. */
function layoutPattern(plan: GrepPlan, sep: string, nameGroup: boolean): RegExp {
  const s     = sep === "-" ? "-" : ":";
  const parts = [
    nameGroup ? `(.+?)${s}` : "",
    plan.lineNumbers ? `${NUM}${s}` : "",
    plan.byteOffset  ? `${NUM}${s}` : "",
    "(.*)",
  ];
  return new RegExp(`^${parts.join("")}$`, "s");
}

/** 정규식 일치에서 줄 번호, 오프셋, 본문을 꺼낸다. */
function fromMatch(plan: GrepPlan, m: RegExpExecArray, nameGroup: boolean, file: string): GrepMatch {
  let k = nameGroup ? 2 : 1;
  const line   = plan.lineNumbers ? parseInt(m[k++]!, 10) : 0;
  const offset = plan.byteOffset  ? parseInt(m[k++]!, 10) : undefined;
  const text   = plan.initialTab && m[k]!.startsWith("\t") ? m[k]!.slice(1) : m[k]!;
  return { file, line, text, ...(offset !== undefined && { byte_offset: offset }) };
}

/** 이름 열을 알려진 파일 이름 목록으로 가른다. 긴 이름을 먼저 맞춰 본다. */
function splitKnownName(plan: GrepPlan, line: string, names: string[]): GrepMatch | null {
  for (const name of names) {
    for (const sep of plan.context ? [":", "-"] : [":"]) {
      if (!line.startsWith(name + sep)) continue;
      const m = layoutPattern(plan, sep, false).exec(line.slice(name.length + 1));
      if (m) return { ...fromMatch(plan, m, false, name), ...(sep === "-" && { context: true as const }) };
    }
  }
  return null;
}

/** 문맥 줄이 아닌 일치 줄에서 파일 이름을 가린다(-n이나 -b가 있으면 숫자 열 앞까지). */
function lazyMatch(plan: GrepPlan, line: string): GrepMatch | null {
  const m = layoutPattern(plan, ":", true).exec(line);
  return m ? fromMatch(plan, m, true, m[1]!) : null;
}

/**
 * 파일 이름 열이 있는 줄을 해석한다.
 * 피연산자가 파일 이름이면 그 이름으로 가르고, -r에서는 일치 줄(`이름:번호:`)에서 이름을 모아 문맥 줄(`이름-번호-`)을 가른다.
 */
function parseNamedLines(plan: GrepPlan, lines: string[], known: Set<string>): GrepMatch[] {
  const named = plan.lineNumbers || plan.byteOffset;
  if (named && plan.recursive) {
    for (const line of lines) {
      const hit = lazyMatch(plan, line);
      if (hit && hit.file) known.add(hit.file);
    }
  }
  const names = [...known].sort((a, b) => b.length - a.length);

  return lines.map(line => {
    const exact = splitKnownName(plan, line, names);
    if (exact) return exact;
    const lazy = lazyMatch(plan, line);
    if (lazy) return lazy;
    if (!named) {
      const idx = line.indexOf(":");
      if (idx > 0) return { file: line.slice(0, idx), line: 0, text: line.slice(idx + 1) };
    }
    return { file: "", line: 0, text: line };
  });
}

/** 파일 이름 열이 없는 줄을 해석한다. */
function parseBareLines(plan: GrepPlan, lines: string[]): GrepMatch[] {
  const named = plan.lineNumbers || plan.byteOffset;
  return lines.map(line => {
    if (!named) return { file: "", line: 0, text: line };
    for (const sep of plan.context ? [":", "-"] : [":"]) {
      const m = layoutPattern(plan, sep, false).exec(line);
      if (m) return { ...fromMatch(plan, m, false, ""), ...(sep === "-" && { context: true as const }) };
    }
    return { file: "", line: 0, text: line };
  });
}

/**
 * -r에 파일 피연산자가 하나일 때 그 피연산자가 디렉터리인지 출력으로 가린다.
 * 디렉터리면 모든 줄이 피연산자 경로로 시작하고, 파일이면 이름 열이 없다.
 */
function operandIsDirectory(operand: string, lines: string[]): boolean {
  if (lines.length === 0) return false;
  const prefix = operand.endsWith("/") ? operand : `${operand}/`;
  const hits   = lines.filter(l => l.startsWith(prefix)).length;
  if (hits === lines.length) return true;
  if (hits === 0) return false;
  throw new UnrecognizedOutputError(`Cannot tell whether grep operand '${operand}' is a file or a directory from its output`);
}

export function parseGrep(
  cmd: string, args: string[], raw: string, ctx?: ParseContext,
): { matches: GrepMatch[]; _summary?: GrepSummary } {
  const plan    = analyze(args);
  const sepChar = plan.nullSep ? "\0" : "\n";
  const lines   = raw.split(sepChar).filter(l => l.trim() && !(plan.context && l === "--"));

  let matches: GrepMatch[];
  if (plan.kind === "list") {
    matches = lines.map(line => ({ file: line, line: 0, text: "" }));
  } else {
    const showName = plan.showName === "infer" ? operandIsDirectory(plan.files[0]!, lines) : plan.showName;
    if (plan.kind === "count") {
      matches = lines.map(line => {
        const m = /^(.*):(\d+)$/s.exec(line);
        return showName && m ? { file: m[1]!, line: 0, text: m[2]! } : { file: "", line: 0, text: line };
      });
    } else if (showName) {
      matches = parseNamedLines(plan, lines, new Set(plan.recursive ? [] : plan.files));
    } else {
      matches = parseBareLines(plan, lines);
    }
  }

  const maxItems = ctx?.maxItems ?? 0;
  if (maxItems > 0 && matches.length > maxItems) {
    return {
      matches:  matches.slice(0, maxItems),
      _summary: { total: matches.length, shown: maxItems, truncated: true },
    };
  }
  return { matches };
}
