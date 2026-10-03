export interface DuEntry {
  size: string;
  path: string;
  /** --time으로 표시한 마지막 수정 시각 */
  modified_at?: string;
}

/** 값을 받는 du 짧은 옵션. 묶음에서 이 글자 뒤는 값이다. */
const SHORT_VALUE_FLAGS = new Set(["d", "t", "B"]);

/** "=" 없이 쓰면 다음 인자가 값인 du 긴 옵션 */
const LONG_VALUE_FLAGS = new Set(["--max-depth", "--exclude", "--threshold", "--block-size", "--time-style", "--exclude-from", "--files0-from"]);

/** -0(--null)이 있는지. 단문자 묶음(-s0)도 보고, 값 옵션 뒤의 글자(-d0)와 값 인자는 건너뛴다. */
function nulTerminated(args: string[]): boolean {
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--") return false;
    if (a.startsWith("--")) {
      if (a === "--null") return true;
      if (!a.includes("=") && LONG_VALUE_FLAGS.has(a)) i++;
      continue;
    }
    if (!a.startsWith("-") || a === "-") continue;
    for (let j = 1; j < a.length; j++) {
      const c = a[j]!;
      if (c === "0") return true;
      if (!SHORT_VALUE_FLAGS.has(c)) continue;
      if (j === a.length - 1) i++;
      break;
    }
  }
  return false;
}

/**
 * du 출력 파싱. 줄은 "크기 TAB 경로"이고 --time이면 "크기 TAB 시각 TAB 경로"다.
 * -0이면 줄바꿈 대신 NUL로 끝난다.
 */
export function parseDu(cmd: string, args: string[], raw: string): { entries: DuEntry[] } {
  const entries: DuEntry[] = [];
  const terminator = nulTerminated(args) ? "\0" : "\n";
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
