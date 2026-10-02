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

/** ss가 표시하는 소켓 상태. 머리 줄이 없을 때 첫 열이 Netid인지 State인지 가리는 데 쓴다. */
const STATES = new Set([
  "ESTAB", "SYN-SENT", "SYN-RECV", "FIN-WAIT-1", "FIN-WAIT-2", "TIME-WAIT", "UNCONN", "CLOSE-WAIT", "LAST-ACK", "LISTEN", "CLOSING", "CLOSE",
]);

/** 유닉스 소켓 Netid(u_str, u_dgr, u_seq). 주소 열이 "경로 inode" 두 낱말이다. */
const UNIX_NETID = /^u_/;

/** "addr:port" 한 낱말을 주소와 포트로 가른다. 포트가 없으면(* 등) 포트는 빈 문자열이다. */
function splitAddr(full: string | undefined): [string, string] {
  if (!full) return ["", ""];
  const lastColon = full.lastIndexOf(":");
  return lastColon >= 0 ? [full.slice(0, lastColon), full.slice(lastColon + 1)] : [full, ""];
}

/** 열 구성: Netid와 State 열은 필터에 따라 빠진다(예: 종류 하나만 고르면 Netid가, 상태 하나만 고르면 State가 없다). */
interface Layout {
  netid: boolean;
  state: boolean;
}

/** 머리 줄의 낱말로, 머리 줄이 없으면(-H) 첫 행의 낱말로 열 구성을 정한다. */
function layoutOf(first: string[], header: boolean): Layout {
  if (header) return { netid: first.includes("Netid"), state: first.includes("State") };
  if (/^\d+$/.test(first[0] ?? "")) return { netid: false, state: false };
  if (STATES.has(first[0] ?? "")) return { netid: false, state: true };
  return { netid: true, state: !/^\d+$/.test(first[1] ?? "") };
}

/** Netid 열이 없는 출력(종류 필터가 하나)에서 필터 플래그로 Netid를 정한다. 정할 수 없으면 빈 문자열. */
function netidFromArgs(args: string[]): string {
  const shorts = new Set(args.filter(a => /^-[A-Za-z0-9]+$/.test(a)).flatMap(a => [...a.slice(1)]));
  const kinds  = [
    ...(shorts.has("t") || args.includes("--tcp") ? ["tcp"] : []),
    ...(shorts.has("u") || args.includes("--udp") ? ["udp"] : []),
    ...(shorts.has("w") || args.includes("--raw") ? ["raw"] : []),
  ];
  return kinds.length === 1 ? kinds[0]! : "";
}

export function parseSs(cmd: string, args: string[], raw: string): { connections: SsEntry[] } {
  const lines       = raw.split("\n").filter(l => l.trim() && !/^\s/.test(l));
  const connections: SsEntry[] = [];
  if (lines.length === 0) return { connections };

  const head   = lines[0]!.trim().split(/\s+/);
  const header = head[0] === "Netid" || head[0] === "State" || head[0] === "Recv-Q";
  const layout = layoutOf(head, header);
  const implied = layout.netid ? "" : netidFromArgs(args);

  for (const line of header ? lines.slice(1) : lines) {
    const cols = line.trim().split(/\s+/);
    let at     = 0;
    const id    = layout.netid ? cols[at++]! : implied;
    const state = layout.state ? cols[at++]! : "";
    const recvQ = cols[at++];
    const sendQ = cols[at++];
    const addrs = cols.slice(at);
    if (recvQ === undefined || sendQ === undefined || addrs.length < 1) continue;

    let local: [string, string];
    let peer:  [string, string];
    if (UNIX_NETID.test(id) && addrs.length >= 4) {
      local = [addrs[0]!, addrs[1]!];
      peer  = [addrs[2]!, addrs[3]!];
    } else {
      local = splitAddr(addrs[0]);
      peer  = splitAddr(addrs[1]);
    }

    connections.push({
      netid:         id,
      state,
      recv_q:        parseInt(recvQ, 10),
      send_q:        parseInt(sendQ, 10),
      local_address: local[0],
      local_port:    local[1],
      peer_address:  peer[0],
      peer_port:     peer[1],
    });
  }

  return { connections };
}
