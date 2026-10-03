/**
 * journalctl short 계열 출력 파싱.
 * 형식: <시각> <호스트> <유닛>[<pid>]: <메시지>. --no-hostname이면 호스트가 없다.
 * 시각의 모양은 -o 값으로 정해진다(기본 short).
 * Linux 전용. macOS/Windows는 { lines } 폴백.
 *
 * @author 최진호
 * @date 2026-03-07
 */

import type { ParseContext } from "../registry.js";

export interface JournalctlEntry {
  timestamp: string;
  /** --no-hostname이면 빈 문자열 */
  hostname:  string;
  unit:      string;
  pid?:      number;
  message:   string;
}

export interface JournalctlResult {
  entries: JournalctlEntry[];
}

const UNIT_PID = /^([^[]+)\[(\d+)\]/;

/** -o 값별 시각 앞부분 */
const TIMESTAMPS: Readonly<Record<string, RegExp>> = {
  "short":            /^[A-Z][a-z]{2} [ \d]\d \d{2}:\d{2}:\d{2}/,
  "short-precise":    /^[A-Z][a-z]{2} [ \d]\d \d{2}:\d{2}:\d{2}\.\d+/,
  "short-iso":        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:?\d{2}/,
  "short-iso-precise": /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d+[+-]\d{2}:?\d{2}/,
  "short-full":       /^[A-Z][a-z]{2} \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} \S+/,
  "with-unit":        /^[A-Z][a-z]{2} \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} \S+/,
  "short-unix":       /^\d+\.\d+/,
  "short-monotonic":  /^\[\s*\d+\.\d+\]/,
};

/** 인자에서 출력 형식을 읽는다. 지정이 없으면 null(기본 short). */
function outputFormat(args: string[]): string | null {
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "-o" || a === "--output") return args[i + 1] ?? null;
    if (a.startsWith("--output=")) return a.slice(9);
    if (/^-o.+/.test(a)) return a.slice(2);
  }
  return null;
}

/** 형식이 지정되지 않았으면 기본 short를 먼저, 그다음 첫 줄에 맞는 형식을 고른다. */
function timestampPattern(args: string[], first: string): RegExp | undefined {
  const named = outputFormat(args);
  if (named !== null) return TIMESTAMPS[named];
  return TIMESTAMPS["short"]!.test(first) ? TIMESTAMPS["short"] : Object.values(TIMESTAMPS).find(re => re.test(first));
}

/**
 * journalctl short 계열 출력을 파싱한다.
 * 시각으로 시작하지 않는 줄은 줄바꿈이 든 메시지의 이어지는 줄로 보고 직전 항목의 message에 붙인다.
 */
export function parseJournalctl(
  _cmd: string,
  args: string[],
  raw: string,
  ctx?: ParseContext,
): JournalctlResult | { lines: string[] } {
  const lines = raw.split("\n").filter(Boolean);
  if (lines.length === 0) return { entries: [] };

  const timestampRe = timestampPattern(args, lines.find(l => Object.values(TIMESTAMPS).some(re => re.test(l))) ?? lines[0]!);
  const noHostname  = args.includes("--no-hostname");
  if (!timestampRe || !lines.some(l => timestampRe.test(l))) return { lines };

  const entries: JournalctlEntry[] = [];
  for (const line of lines) {
    const ts = timestampRe.exec(line);
    if (!ts) {
      const last = entries[entries.length - 1];
      if (last && !/^-- /.test(line)) last.message += `\n${line}`;
      continue;
    }

    const timestamp = ts[0];
    const rest      = line.slice(timestamp.length).trimStart();

    let hostname = "";
    let unitPart = rest;
    if (!noHostname) {
      const sp = rest.indexOf(" ");
      if (sp < 0) continue;
      hostname = rest.slice(0, sp);
      unitPart = rest.slice(sp + 1);
    }

    const colonIdx = unitPart.indexOf(": ");
    const unitRaw  = colonIdx < 0 ? unitPart.replace(/:$/, "") : unitPart.slice(0, colonIdx);
    const message  = colonIdx < 0 ? "" : unitPart.slice(colonIdx + 2);

    const unitMatch = unitRaw.match(UNIT_PID);
    const unit = unitMatch ? unitMatch[1]!.trim() : unitRaw.trim();
    const pid  = unitMatch ? parseInt(unitMatch[2]!, 10) : undefined;

    entries.push({ timestamp, hostname, unit, pid, message });
  }

  const maxItems = ctx?.maxItems ?? 0;
  const result = maxItems > 0 && entries.length > maxItems
    ? entries.slice(0, maxItems)
    : entries;

  return { entries: result };
}
