export interface DuEntry {
  /** du가 출력한 크기 글자 그대로(블록 수, 4.0K 같은 사람용 단위) */
  size: string;
  /** 단위가 바이트로 정해진 실행(-b, --bytes, -B1, --block-size=1)에서만 있는 크기(바이트) */
  size_bytes?: number;
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
 * 크기 열의 단위가 바이트인지. -b(--bytes)와 블록 크기 1(-B1, -B 1, --block-size=1)만 바이트다.
 * 아무 옵션이 없으면 단위는 환경(BLOCK_SIZE, POSIXLY_CORRECT)에 따라 1024나 512바이트라서 바이트로 바꾸지 않는다.
 * 뒤에 오는 단위 옵션(-h, -k, -m, --si, -B 다른 값)이 앞의 것을 덮는다.
 */
function bytesUnit(args: string[]): boolean {
  let bytes = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--") break;
    if (a === "--bytes") { bytes = true; continue; }
    if (a === "--human-readable" || a === "--si") { bytes = false; continue; }
    if (a.startsWith("--block-size")) {
      const value = a.includes("=") ? a.slice(a.indexOf("=") + 1) : args[++i];
      bytes = value === "1";
      continue;
    }
    if (a.startsWith("--") || !a.startsWith("-") || a === "-") {
      if (a.startsWith("--") && !a.includes("=") && LONG_VALUE_FLAGS.has(a)) i++;
      continue;
    }
    for (let j = 1; j < a.length; j++) {
      const c = a[j]!;
      if (c === "b") bytes = true;
      else if (c === "h" || c === "k" || c === "m") bytes = false;
      else if (c === "B") {
        const value = j < a.length - 1 ? a.slice(j + 1) : args[++i];
        bytes = value === "1";
        break;
      } else if (SHORT_VALUE_FLAGS.has(c)) {
        if (j === a.length - 1) i++;
        break;
      }
    }
  }
  return bytes;
}

/**
 * du 출력 파싱. 줄은 "크기 TAB 경로"이고 --time이면 "크기 TAB 시각 TAB 경로"다.
 * -0이면 줄바꿈 대신 NUL로 끝난다.
 */
export function parseDu(cmd: string, args: string[], raw: string): { entries: DuEntry[] } {
  const entries: DuEntry[] = [];
  const terminator = nulTerminated(args) ? "\0" : "\n";
  const timed      = args.some(a => a === "--time" || a.startsWith("--time="));
  const inBytes    = bytesUnit(args);

  for (const line of raw.split(terminator)) {
    if (!line.trim()) continue;
    const cols = line.split("\t");
    if (cols.length < 2 || !cols[0]) continue;
    /**
     * 크기와 시각만 다듬는다. 경로는 그대로 둔다 — 이름에 앞뒤 공백이 있어도 보존해야 한다.
     */
    const size  = cols[0].trim();
    const bytes = inBytes && /^[0-9]+$/.test(size) ? { size_bytes: Number(size) } : {};
    if (timed && cols.length >= 3) {
      entries.push({ size, ...bytes, modified_at: cols[1]!.trim(), path: cols.slice(2).join("\t") });
    } else {
      entries.push({ size, ...bytes, path: cols.slice(1).join("\t") });
    }
  }

  return { entries };
}
