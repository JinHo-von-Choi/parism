export function parseHead(cmd: string, args: string[], raw: string): { lines: string[] } {
  return { lines: raw.split("\n") };
}
