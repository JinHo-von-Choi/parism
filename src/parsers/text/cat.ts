export function parseCat(cmd: string, args: string[], raw: string): { lines: string[] } {
  return { lines: raw.split("\n") };
}
