export function parseWhich(cmd: string, args: string[], raw: string): { paths: string[] } {
  return { paths: raw.split("\n").map(l => l.trim()).filter(Boolean) };
}
