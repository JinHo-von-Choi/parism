/**
 * journalctl 출력 파싱.
 * short-iso 형식: ISO8601 hostname unit[pid]: message
 * Linux 전용. macOS/Windows는 { lines } 폴백.
 *
 * @author 최진호
 * @date 2026-03-07
 */

import type { ParseContext } from "../registry.js";

export interface JournalctlEntry {
  timestamp: string;
  hostname:  string;
  unit:      string;
  pid?:      number;
  message:   string;
}

export interface JournalctlResult {
  entries: JournalctlEntry[];
}

const ISO_TS = /^\d{4}-\d{2}-\d{2}T[\d:.+-]+/;
const UNIT_PID = /^([^[]+)\[(\d+)\]/;

/**
 * journalctl -o short-iso 출력을 파싱한다.
 * 형식: 2026-03-07T21:18:08+09:00 hostname unit[pid]: message
 */
export function parseJournalctl(
  _cmd: string,
  _args: string[],
  raw: string,
  ctx?: ParseContext,
): JournalctlResult | { lines: string[] } {
  const lines = raw.split("\n").filter(Boolean);
  if (lines.length === 0) return { entries: [] };
  if (!lines.some(l => ISO_TS.test(l))) return { lines };

  const entries: JournalctlEntry[] = [];
  for (const line of lines) {
    if (!ISO_TS.test(line)) continue;

    const firstSpace = line.indexOf(" ");
    if (firstSpace < 0) continue;

    const timestamp = line.slice(0, firstSpace);
    const rest      = line.slice(firstSpace + 1);

    const secondSpace = rest.indexOf(" ");
    if (secondSpace < 0) continue;

    const hostname = rest.slice(0, secondSpace);
    const unitPart = rest.slice(secondSpace + 1);

    const colonIdx = unitPart.indexOf(": ");
    if (colonIdx < 0) continue;

    const unitRaw = unitPart.slice(0, colonIdx);
    const message = unitPart.slice(colonIdx + 2);

    const unitMatch = unitRaw.match(UNIT_PID);
    const unit = unitMatch ? unitMatch[1].trim() : unitRaw.trim();
    const pid  = unitMatch ? parseInt(unitMatch[2], 10) : undefined;

    entries.push({
      timestamp,
      hostname,
      unit,
      pid,
      message,
    });
  }

  const maxItems = ctx?.maxItems ?? 0;
  const result = maxItems > 0 && entries.length > maxItems
    ? entries.slice(0, maxItems)
    : entries;

  return { entries: result };
}
