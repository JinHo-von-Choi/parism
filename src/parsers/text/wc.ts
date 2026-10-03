import { UnrecognizedOutputError } from "../registry.js";

export interface WcEntry {
  count: number;
  file:  string;
}

/** 파일별 개수, 또는 --total=only의 합계 하나 */
export type WcResult = { entries: WcEntry[] } | { total: number };

export function parseWc(cmd: string, args: string[], raw: string): WcResult {
  /** --total는 마지막 값이 적용된다. */
  if (args.filter(a => a.startsWith("--total=")).pop() === "--total=only") {
    const text = raw.trim();
    if (!/^\d+$/.test(text)) throw new UnrecognizedOutputError("wc --total=only output is not a single count");
    return { total: parseInt(text, 10) };
  }
  const entries = raw.split("\n").filter(Boolean).map(line => {
    /** 개수 열은 너비를 맞추느라 앞에 공백이 붙고, 공백 한 칸 뒤부터 줄 끝까지가 이름이다. */
    const m = /^\s*(\d+)(?: (.*))?$/s.exec(line);
    if (!m) throw new UnrecognizedOutputError(`wc output line is not 'count name': ${line.slice(0, 80)}`);
    return { count: parseInt(m[1]!, 10), file: m[2] ?? "" };
  });
  return { entries };
}
