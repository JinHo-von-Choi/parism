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

/** 값을 따로 받는 짧은 옵션. 다음 인자는 패턴 또는 파일이 아니다. */
const VALUE_FLAGS = new Set(["-A", "-B", "-C", "-m", "-e", "-f", "-d", "-D"]);

/** 플래그와 파일 인자 수로 grep 출력 형식을 정한다. */
function detectFormat(args: string[]): GrepFormat {
  const shorts: string[] = [];
  const longs:  string[] = [];
  const operands: string[] = [];
  let patternGiven = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--") { operands.push(...args.slice(i + 1)); break; }
    if (a.startsWith("--")) { longs.push(a.split("=")[0]!); continue; }
    if (/^-[A-Za-z]+$/.test(a)) {
      shorts.push(...a.slice(1));
      if (VALUE_FLAGS.has(a)) { if (a === "-e" || a === "-f") patternGiven = true; i++; }
      continue;
    }
    operands.push(a);
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
