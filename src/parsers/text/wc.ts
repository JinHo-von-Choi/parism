export function parseWc(cmd: string, args: string[], raw: string): { entries: Array<{ count: number; file: string }> } {
  const entries = raw.split("\n").filter(Boolean).map(line => {
    const parts = line.trim().split(/\s+/);
    return { count: parseInt(parts[0], 10), file: parts.slice(1).join(" ") };
  });
  return { entries };
}
