export function parseEnv(cmd: string, args: string[], raw: string): { vars: Record<string, string> } {
  const vars: Record<string, string> = {};

  for (const line of raw.split("\n")) {
    const eqIdx = line.indexOf("=");
    if (eqIdx < 0) continue;
    const key   = line.slice(0, eqIdx);
    const value = line.slice(eqIdx + 1);
    vars[key]   = value;
  }

  return { vars };
}
