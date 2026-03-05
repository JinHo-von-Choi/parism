export interface GitCommit {
  hash:    string;
  message: string;
}

export function parseGitLog(cmd: string, args: string[], raw: string): { commits: GitCommit[] } {
  const commits: GitCommit[] = [];

  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    const m = line.match(/^([a-f0-9]+)\s+(.+)$/);
    if (m) commits.push({ hash: m[1], message: m[2] });
  }

  return { commits };
}
