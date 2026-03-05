export function parseGitDiff(cmd: string, args: string[], raw: string): { raw: string; files_changed: string[] } {
  const files = raw.match(/^---\s+a\/(.+)$/gm)?.map(l => l.replace(/^---\s+a\//, "")) ?? [];
  return { raw, files_changed: files };
}
