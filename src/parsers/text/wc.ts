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
    const parts = line.trim().split(/\s+/);
    return { count: parseInt(parts[0]!, 10), file: parts.slice(1).join(" ") };
  });
  return { entries };
}
