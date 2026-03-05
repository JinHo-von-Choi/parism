export interface DuEntry {
  size: string;
  path: string;
}

export function parseDu(cmd: string, args: string[], raw: string): { entries: DuEntry[] } {
  const entries: DuEntry[] = [];

  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    const [size, ...rest] = line.split("\t");
    if (size && rest.length) {
      entries.push({ size: size.trim(), path: rest.join("\t").trim() });
    }
  }

  return { entries };
}
