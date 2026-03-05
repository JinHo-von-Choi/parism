export function parsePwd(cmd: string, args: string[], raw: string): { path: string } {
  return { path: raw.trim() };
}
