import type { ParseContext } from "../registry.js";

export interface PsEntry {
  user:    string;
  pid:     number;
  cpu:     number;
  mem:     number;
  vsz:     number;
  rss:     number;
  tty:     string;
  stat:    string;
  start:   string;
  time:    string;
  command: string;
}

export interface PsSummary {
  total:     number;
  shown:     number;
  truncated: boolean;
}

export function parsePs(
  cmd: string, args: string[], raw: string, ctx?: ParseContext,
): { processes: PsEntry[]; _summary?: PsSummary } {
  const lines     = raw.split("\n").filter(Boolean);
  const processes: PsEntry[] = [];

  for (const line of lines.slice(1)) {
    const cols = line.trim().split(/\s+/);
    if (cols.length < 11) continue;
    processes.push({
      user:    cols[0],
      pid:     parseInt(cols[1], 10),
      cpu:     parseFloat(cols[2]),
      mem:     parseFloat(cols[3]),
      vsz:     parseInt(cols[4], 10),
      rss:     parseInt(cols[5], 10),
      tty:     cols[6],
      stat:    cols[7],
      start:   cols[8],
      time:    cols[9],
      command: cols.slice(10).join(" "),
    });
  }

  const maxItems = ctx?.maxItems ?? 0;
  if (maxItems > 0 && processes.length > maxItems) {
    return {
      processes: processes.slice(0, maxItems),
      _summary:  { total: processes.length, shown: maxItems, truncated: true },
    };
  }
  return { processes };
}
