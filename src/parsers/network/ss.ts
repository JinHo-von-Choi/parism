export interface SsEntry {
  netid:         string;
  state:         string;
  recv_q:        number;
  send_q:        number;
  local_address: string;
  local_port:    string;
  peer_address:  string;
  peer_port:     string;
}

export function parseSs(cmd: string, args: string[], raw: string): { connections: SsEntry[] } {
  const lines       = raw.split("\n").filter(Boolean);
  const connections: SsEntry[] = [];

  for (const line of lines.slice(1)) { // 헤더 제외
    const cols = line.trim().split(/\s+/);
    if (cols.length < 5) continue;

    const [netid, state, recv_q, send_q, localFull, peerFull] = cols;

    const splitAddr = (full: string): [string, string] => {
      if (!full) return ["", ""];
      const lastColon = full.lastIndexOf(":");
      return lastColon >= 0
        ? [full.slice(0, lastColon), full.slice(lastColon + 1)]
        : [full, ""];
    };

    const [local_address, local_port] = splitAddr(localFull ?? "");
    const [peer_address, peer_port]   = splitAddr(peerFull ?? "");

    connections.push({
      netid,
      state,
      recv_q:  parseInt(recv_q, 10),
      send_q:  parseInt(send_q, 10),
      local_address,
      local_port,
      peer_address,
      peer_port,
    });
  }

  return { connections };
}
