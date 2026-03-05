export function parseTail(cmd: string, args: string[], raw: string): { lines: string[] } {
  return { lines: raw.split("\n") };
}
