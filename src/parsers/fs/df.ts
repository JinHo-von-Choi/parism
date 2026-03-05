export interface DfEntry {
  filesystem:  string;
  blocks_1k:   string;
  used:        string;
  available:   string;
  use_percent: string;
  mounted_on:  string;
}

export function parseDf(cmd: string, args: string[], raw: string): { filesystems: DfEntry[] } {
  const lines       = raw.split("\n").filter(Boolean);
  const filesystems: DfEntry[] = [];

  for (const line of lines.slice(1)) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 6) continue;
    filesystems.push({
      filesystem:  parts[0],
      blocks_1k:   parts[1],
      used:        parts[2],
      available:   parts[3],
      use_percent: parts[4],
      mounted_on:  parts[5],
    });
  }

  return { filesystems };
}
