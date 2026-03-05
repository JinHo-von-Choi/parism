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

export function parseGrep(
  cmd: string, args: string[], raw: string, ctx?: ParseContext,
): { matches: GrepMatch[]; _summary?: GrepSummary } {
  const matches: GrepMatch[] = [];

  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;

    // Case 1: 첫 세그먼트가 순수 숫자 → linenum:text (단일파일 grep -n)
    const lineNumOnly = line.match(/^(\d+):(.*)$/);
    if (lineNumOnly) {
      matches.push({ file: "", line: parseInt(lineNumOnly[1]!, 10), text: lineNumOnly[2]! });
      continue;
    }

    // Case 2: file:linenum:text 형태 (grep -rn 또는 다중파일 -n)
    const withLineNum = line.match(/^([^:]+):(\d+):(.*)$/);
    if (withLineNum) {
      matches.push({
        file: withLineNum[1]!,
        line: parseInt(withLineNum[2]!, 10),
        text: withLineNum[3]!,
      });
      continue;
    }

    // Case 3: file:text 형태 (grep -r without -n) — 콜론 앞이 파일 경로
    const colonIdx = line.indexOf(":");
    if (colonIdx > 0) {
      matches.push({
        file: line.slice(0, colonIdx),
        line: 0,
        text: line.slice(colonIdx + 1),
      });
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
