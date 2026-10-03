import { UnrecognizedOutputError } from "../registry.js";

/** 개수 플래그 하나로 센 파일별 개수 */
export interface WcEntry {
  count: number;
  file:  string;
}

/** 개수 플래그가 없거나 둘 이상일 때 파일별 개수. 고른 열만 담는다. */
export interface WcCounts {
  lines?:           number;
  words?:           number;
  chars?:           number;
  bytes?:           number;
  max_line_length?: number;
  file:             string;
}

/** 파일별 개수, 또는 --total=only의 합계 하나 */
export type WcResult = { entries: Array<WcEntry | WcCounts> } | { total: number };

type WcColumn = "lines" | "words" | "chars" | "bytes" | "max_line_length";

/** GNU wc가 열을 내는 순서와 각 열을 고르는 플래그 */
const COLUMNS: ReadonlyArray<readonly [WcColumn, string, string]> = [
  ["lines", "l", "--lines"], ["words", "w", "--words"], ["chars", "m", "--chars"], ["bytes", "c", "--bytes"], ["max_line_length", "L", "--max-line-length"],
];

/** 플래그 없이 실행하면 줄, 낱말, 바이트 수를 낸다. */
const DEFAULT_COLUMNS: readonly WcColumn[] = ["lines", "words", "bytes"];

/** 인자로 고른 개수 열을 출력 순서대로 돌려준다. 플래그가 없으면 기본 세 열이다. */
function selectedColumns(args: string[]): WcColumn[] {
  const shorts = new Set<string>();
  const longs  = new Set<string>();
  for (const a of args) {
    if (a === "--") break;
    if (a.startsWith("--")) longs.add(a);
    else if (/^-[A-Za-z]+$/.test(a)) for (const c of a.slice(1)) shorts.add(c);
  }
  const chosen = COLUMNS.filter(([, s, l]) => shorts.has(s) || longs.has(l)).map(([name]) => name);
  return chosen.length > 0 ? chosen : [...DEFAULT_COLUMNS];
}

/** 마지막 --total 값. --total는 마지막 값이 적용된다. */
function totalMode(args: string[]): string | undefined {
  return args.filter(a => a.startsWith("--total=")).pop()?.slice("--total=".length);
}

/** --total=only는 합계 하나만 내므로 개수 열이 하나일 때만 받는다. */
export function supportsWc(args: string[]): boolean {
  return totalMode(args) !== "only" || selectedColumns(args).length === 1;
}

/**
 * wc 출력을 파싱한다. 개수 열은 너비를 맞추느라 앞과 사이에 공백이 붙고, 마지막 개수 다음 한 칸 뒤부터 줄 끝까지가 이름이다.
 * 열 수는 인자로 정해지므로 숫자로 시작하는 이름도 개수로 읽지 않는다. 시간 복잡도는 출력 길이에 선형이다.
 */
export function parseWc(cmd: string, args: string[], raw: string): WcResult {
  if (totalMode(args) === "only") {
    const text = raw.trim();
    if (!/^\d+$/.test(text)) throw new UnrecognizedOutputError("wc --total=only output is not a single count");
    return { total: parseInt(text, 10) };
  }
  const columns = selectedColumns(args);
  const row     = new RegExp(`^\\s*${columns.map(() => "(\\d+)").join("\\s+")}(?: (.*))?$`, "s");
  const entries = raw.split("\n").filter(Boolean).map((line): WcEntry | WcCounts => {
    const m = row.exec(line);
    if (!m) throw new UnrecognizedOutputError(`wc output line does not have ${columns.length} count column(s) and a name: ${line.slice(0, 80)}`);
    const file = m[columns.length + 1] ?? "";
    if (columns.length === 1) return { count: parseInt(m[1]!, 10), file };
    const counts: WcCounts = { file };
    columns.forEach((name, i) => { counts[name] = parseInt(m[i + 1]!, 10); });
    return counts;
  });
  return { entries };
}
