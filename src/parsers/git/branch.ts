export interface GitBranchEntry {
  current:  boolean;
  name:     string;
  hash:     string;
  upstream: string | null;
  ahead:    number;
  behind:   number;
  message:  string;
}

export function parseGitBranch(cmd: string, args: string[], raw: string): { branches: GitBranchEntry[] } {
  const branches: GitBranchEntry[] = [];

  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;

    const current = line.startsWith("*");
    const rest    = line.slice(2); // "* " 또는 "  " 제거

    const m = rest.match(/^(\S+)\s+([a-f0-9]+)\s+(?:\[([^\]]+)\]\s+)?(.+)$/);
    if (!m) continue;

    const [, name, hash, upstreamRaw, message] = m;

    let upstream: string | null = null;
    let ahead    = 0;
    let behind   = 0;

    if (upstreamRaw) {
      const aheadMatch  = upstreamRaw.match(/ahead (\d+)/);
      const behindMatch = upstreamRaw.match(/behind (\d+)/);
      ahead    = aheadMatch  ? parseInt(aheadMatch[1],  10) : 0;
      behind   = behindMatch ? parseInt(behindMatch[1], 10) : 0;
      upstream = upstreamRaw.split(":")[0].trim();
    }

    branches.push({ current, name, hash, upstream, ahead, behind, message });
  }

  return { branches };
}
