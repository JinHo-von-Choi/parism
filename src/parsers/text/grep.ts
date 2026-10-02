import type { ParseContext } from "../registry.js";

export interface GrepMatch {
  file: string;
  line: number;
  text: string;
}

export interface GrepSummary {
  total:     number;
  shown:     number;
  truncated: boolean;
}

type GrepFormat = "file_line_text" | "line_text" | "file_text" | "text" | "file_only";

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

/** 플래그와 파일 인자 수로 grep 출력 형식을 정한다. 옵션 값은 피연산자로 세지 않는다. */
function detectFormat(args: string[]): GrepFormat {
  const shorts:   string[] = [];
  const longs:    string[] = [];
  const operands: string[] = [];
  let   patternGiven       = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--") { operands.push(...args.slice(i + 1)); break; }
    if (a === "-" || !a.startsWith("-")) { operands.push(a); continue; }
    if (a.startsWith("--")) {
      const eq   = a.indexOf("=");
      const name = eq >= 0 ? a.slice(0, eq) : a;
      longs.push(name);
      if (PATTERN_FLAGS.has(name)) patternGiven = true;
      if (eq < 0 && LONG_VALUE_FLAGS.has(name)) i++;
      continue;
    }
    if (/^-[0-9]+$/.test(a)) continue;
    for (let j = 1; j < a.length; j++) {
      const c = a[j]!;
      shorts.push(c);
      if (!SHORT_VALUE_FLAGS.has(c)) continue;
      if (PATTERN_FLAGS.has(c)) patternGiven = true;
      if (j === a.length - 1) i++;
      break;
    }
  }
  const has       = (c: string, long: string): boolean => shorts.includes(c) || longs.includes(long);
  const files     = patternGiven ? operands : operands.slice(1);
  const recursive = has("r", "--recursive") || has("R", "--dereference-recursive");
  const showName  = !has("h", "--no-filename") && (has("H", "--with-filename") || recursive || files.length > 1);

  if (has("l", "--files-with-matches")) return "file_only";
  if (has("c", "--count")) return showName ? "file_text" : "text";
  if (has("n", "--line-number")) return showName ? "file_line_text" : "line_text";
  return showName ? "file_text" : "text";
}

export function parseGrep(
  cmd: string, args: string[], raw: string, ctx?: ParseContext,
): { matches: GrepMatch[]; _summary?: GrepSummary } {
  const matches: GrepMatch[] = [];
  const format = detectFormat(args);

  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;

    if (format === "file_line_text") {
      const m = line.match(/^(.+?):(\d+):(.*)$/);
      if (m) matches.push({ file: m[1]!, line: parseInt(m[2]!, 10), text: m[3]! });
      else   matches.push({ file: "", line: 0, text: line });
    } else if (format === "line_text") {
      const m = line.match(/^(\d+):(.*)$/);
      if (m) matches.push({ file: "", line: parseInt(m[1]!, 10), text: m[2]! });
      else   matches.push({ file: "", line: 0, text: line });
    } else if (format === "file_text") {
      const idx = line.indexOf(":");
      if (idx > 0) matches.push({ file: line.slice(0, idx), line: 0, text: line.slice(idx + 1) });
      else         matches.push({ file: "", line: 0, text: line });
    } else if (format === "file_only") {
      matches.push({ file: line, line: 0, text: "" });
    } else {
      matches.push({ file: "", line: 0, text: line });
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
