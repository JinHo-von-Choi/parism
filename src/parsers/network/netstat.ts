const NETSTAT_PROTO_PATTERN = /^(tcp|udp|tcp4|tcp6|udp4|udp6)$/i;

/** 소켓 상태 열: 대문자와 밑줄로만 이뤄진다. PID/Program 열("123/sshd", "-")은 일치하지 않는다. */
const STATE_PATTERN = /^[A-Z][A-Z0-9_]+$/;

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
      state:           cols[5] !== undefined && STATE_PATTERN.test(cols[5]) ? cols[5] : null,
    };
  });

  return { connections };
}
