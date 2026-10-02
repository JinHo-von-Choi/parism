import { UnrecognizedOutputError } from "../registry.js";

export function parseEnv(cmd: string, args: string[], raw: string): { vars: Record<string, string> } {
  const vars: Record<string, string> = {};

  for (const line of raw.split("\n")) {
    if (line === "") continue;
    const eqIdx = line.indexOf("=");
    if (eqIdx < 0) throw new UnrecognizedOutputError(`env output has a line that is not NAME=value (a multi-line value): '${line.slice(0, 40)}'`);
    const key   = line.slice(0, eqIdx);
    const value = line.slice(eqIdx + 1);
    vars[key]   = value;
  }

  return { vars };
}
