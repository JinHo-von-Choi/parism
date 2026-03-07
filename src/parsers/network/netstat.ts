const NETSTAT_PROTO_PATTERN = /^(tcp|udp|tcp4|tcp6|udp4|udp6)$/i;

export function parseNetstat(cmd: string, args: string[], raw: string): { connections: unknown[] } {
  const lines       = raw.split("\n").filter(Boolean);
  const dataLines   = lines.slice(1).filter((line) => {
    const first = line.trim().split(/\s+/)[0];
    return first && first.toLowerCase() !== "proto" && NETSTAT_PROTO_PATTERN.test(first);
  });
  const connections = dataLines.map((line) => {
    const cols = line.trim().split(/\s+/);
    return {
      proto:           cols[0],
      local_address:   cols[3],
      foreign_address: cols[4],
      state:           cols[5],
    };
  });

  return { connections };
}
