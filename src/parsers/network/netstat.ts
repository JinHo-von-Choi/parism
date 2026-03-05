export function parseNetstat(cmd: string, args: string[], raw: string): { connections: unknown[] } {
  const lines       = raw.split("\n").filter(Boolean);
  const connections = lines.slice(1).map(line => {
    const cols = line.trim().split(/\s+/);
    return {
      proto:           cols[0],
      local_address:   cols[3],
      foreign_address: cols[4],
      state:           cols[5],
    };
  }).filter(c => c.proto);

  return { connections };
}
