export interface DuEntry {
  size: string;
  path: string;
  /** --time으로 표시한 마지막 수정 시각 */
  modified_at?: string;
}

/**
 * du 출력 파싱. 줄은 "크기 TAB 경로"이고 --time이면 "크기 TAB 시각 TAB 경로"다.
 * -0이면 줄바꿈 대신 NUL로 끝난다.
 */
export function parseDu(cmd: string, args: string[], raw: string): { entries: DuEntry[] } {
  const entries: DuEntry[] = [];
  const terminator = args.includes("-0") || args.includes("--null") ? "\0" : "\n";
  const timed      = args.some(a => a === "--time" || a.startsWith("--time="));

  for (const line of raw.split(terminator)) {
    if (!line.trim()) continue;
    const cols = line.split("\t");
    if (cols.length < 2 || !cols[0]) continue;
    if (timed && cols.length >= 3) {
      entries.push({ size: cols[0].trim(), modified_at: cols[1]!.trim(), path: cols.slice(2).join("\t").trim() });
    } else {
      entries.push({ size: cols[0].trim(), path: cols.slice(1).join("\t").trim() });
    }
  }

  return { entries };
}
