import { describe, it, expect } from "vitest";
import { parseLsof } from "../../src/parsers/network/lsof.js";
import { parseSs }   from "../../src/parsers/network/ss.js";
import { UnrecognizedOutputError } from "../../src/parsers/registry.js";
import { createRegistry }         from "../../src/parsers/index.js";

describe("parseLsof()", () => {
  const raw = [
    "COMMAND   PID   USER   FD   TYPE DEVICE SIZE/OFF NODE NAME",
    "node     1234  nirna  22u  IPv4  12345      0t0  TCP *:10000 (LISTEN)",
    "node     1234  nirna  23u  IPv4  12346      0t0  TCP localhost:10000->localhost:51234 (ESTABLISHED)",
  ].join("\n");

  it("항목을 파싱한다", () => {
    const result = parseLsof("lsof", ["-i"], raw) as { entries: Array<{ pid: number; state: string | null }> };
    expect(result.entries).toHaveLength(2);
    expect(result.entries[0].pid).toBe(1234);
    expect(result.entries[0].state).toBe("LISTEN");
    expect(result.entries[1].state).toBe("ESTABLISHED");
  });

  it("STATE 괄호 없으면 state는 null", () => {
    const noState = [
      "COMMAND   PID   USER   FD   TYPE DEVICE SIZE/OFF NODE NAME",
      "node     9999  root   10u  IPv4  99999      0t0  TCP *:8080",
    ].join("\n");
    const result = parseLsof("lsof", ["-i"], noState) as { entries: Array<{ state: string | null }> };
    expect(result.entries[0].state).toBeNull();
  });
});

describe("parseLsof() 열 위치", () => {
  const header = "COMMAND     PID  USER   FD      TYPE             DEVICE SIZE/OFF      NODE NAME";
  type Rows = { entries: Array<{ command: string; pid: number; fd: string; type: string; device: string; name: string; state: string | null }> };

  it("DEVICE, SIZE/OFF, NODE가 빈 줄에서도 NAME이 밀리지 않는다", () => {
    const raw = [
      header,
      "bash      12093  root  cwd   unknown                                       /proc/12093/cwd (readlink: Permission denied)",
      "bash      12093  root NOFD                                                 /proc/12093/fd (opendir: Permission denied)",
      "bash     185916 nirna  cwd       DIR               8,16     4096  39469231 /home/nirna/jobs/my project",
    ].join("\n");
    const rows = (parseLsof("lsof", ["-p", "1"], raw) as Rows).entries;
    expect(rows).toHaveLength(3);
    expect(rows[0]).toMatchObject({ pid: 12093, fd: "cwd", type: "unknown", device: "", name: "/proc/12093/cwd (readlink: Permission denied)", state: null });
    expect(rows[1]).toMatchObject({ fd: "NOFD", type: "", device: "", name: "/proc/12093/fd (opendir: Permission denied)" });
    expect(rows[2]).toMatchObject({ command: "bash", pid: 185916, fd: "cwd", type: "DIR", device: "8,16", name: "/home/nirna/jobs/my project" });
  });

  it("DEVICE가 비고 NODE만 있는 줄도 열을 지킨다", () => {
    const raw = [
      "COMMAND       PID  USER   FD      TYPE             DEVICE  SIZE/OFF      NODE NAME",
      "MainThrea 3579390 nirna  mem       REG               0,15           349296685 anon_inode:[io_uring] (stat: No such file or directory)",
    ].join("\n");
    expect((parseLsof("lsof", ["-p", "1"], raw) as Rows).entries[0]).toMatchObject({ type: "REG", device: "0,15", name: "anon_inode:[io_uring] (stat: No such file or directory)", state: null });
  });

  it("머리 줄이 없으면 예외로 알린다", () => {
    expect(() => parseLsof("lsof", [], "bash 1 root cwd DIR 8,1 4096 2 /\n")).toThrow(UnrecognizedOutputError);
  });
});

describe("lsof 사용자 선택(-u)", () => {
  it("-u는 고르는 프로세스만 바꾸고 열은 같아서 받는다", () => {
    const reg = createRegistry();
    for (const args of [["-u", "nirna"], ["-unirna"], ["-u", "^root"], ["-a", "-u", "nirna", "-d", "cwd"], ["-n", "-P", "-a", "-u", "nirna", "-i"]]) {
      expect(reg.parse("lsof", args, "").parse_error?.reason).not.toBe("unsupported_format");
    }
  });

  it("-u 출력의 열을 읽는다", () => {
    const raw = [
      "COMMAND       PID  USER   FD      TYPE DEVICE SIZE/OFF     NODE NAME",
      "systemd      4680 nirna  cwd   unknown                          /proc/4680/cwd (readlink: Permission denied)",
      "(sd-pam)     4701 nirna  cwd   unknown                          /proc/4701/cwd (readlink: Permission denied)",
      "hermes       5024 nirna  cwd       DIR   8,16     4096 37509960 /home/nirna/.hermes",
    ].join("\n") + "\n";
    const r = createRegistry().parse("lsof", ["-a", "-u", "nirna", "-d", "cwd"], raw);
    expect(r.parse_error).toBeUndefined();
    const rows = (r.parsed as { entries: Array<Record<string, unknown>> }).entries;
    expect(rows.map(e => [e.command, e.pid, e.user, e.fd])).toEqual([["systemd", 4680, "nirna", "cwd"], ["(sd-pam)", 4701, "nirna", "cwd"], ["hermes", 5024, "nirna", "cwd"]]);
    expect(rows[2]).toMatchObject({ type: "DIR", device: "8,16", name: "/home/nirna/.hermes" });
  });
});

describe("parseSs() 열 구성", () => {
  type Rows = { connections: Array<{ netid: string; state: string; recv_q: number; local_address: string; local_port: string; peer_address: string; peer_port: string }> };

  it("종류 필터 하나(Netid 열 없음)는 State부터 읽고 netid는 필터에서 얻는다", () => {
    const raw = ["State  Recv-Q Send-Q Local Address:Port  Peer Address:PortProcess", "LISTEN 0      2048   0.0.0.0:38333      0.0.0.0:*          "].join("\n");
    expect((parseSs("ss", ["-tln"], raw) as Rows).connections[0]).toMatchObject({ netid: "tcp", state: "LISTEN", recv_q: 0, local_address: "0.0.0.0", local_port: "38333", peer_port: "*" });
  });

  it("머리 줄이 없는(-H) 출력도 첫 낱말로 열 구성을 정한다", () => {
    expect((parseSs("ss", ["-H", "-t"], "ESTAB 0 0 10.0.0.1:22 10.0.0.2:5000\n") as Rows).connections[0]).toMatchObject({ state: "ESTAB", local_port: "22" });
    expect((parseSs("ss", ["-H"], "tcp ESTAB 0 0 10.0.0.1:22 10.0.0.2:5000\n") as Rows).connections[0]).toMatchObject({ netid: "tcp", state: "ESTAB" });
  });

  it("State 열도 없는 출력(상태 필터 하나)은 state를 비운다", () => {
    const raw = ["Recv-Q Send-Q Local Address:Port Peer Address:PortProcess", "0 0 192.168.1.2:5353 192.168.1.9:5353"].join("\n");
    expect((parseSs("ss", ["-u"], raw) as Rows).connections[0]).toMatchObject({ netid: "udp", state: "", local_port: "5353" });
  });

  it("유닉스 소켓은 경로와 inode를 각각 주소와 포트로 읽는다", () => {
    const raw = [
      "Netid State Recv-Q Send-Q Local Address:Port Peer Address:Port Process",
      "u_str ESTAB 0 0 /run/dbus/system_bus_socket 56466 * 71905",
      "u_str ESTAB 0 0 * 347653584 * 347653585",
    ].join("\n");
    const rows = (parseSs("ss", ["-x"], raw) as Rows).connections;
    expect(rows[0]).toMatchObject({ local_address: "/run/dbus/system_bus_socket", local_port: "56466", peer_address: "*", peer_port: "71905" });
    expect(rows[1]).toMatchObject({ local_address: "*", local_port: "347653584", peer_address: "*", peer_port: "347653585" });
  });

  it("-i의 들여쓴 이어지는 줄은 행으로 세지 않는다", () => {
    const raw = ["Netid State Recv-Q Send-Q Local Address:Port Peer Address:Port Process", "tcp ESTAB 0 0 10.0.0.1:22 10.0.0.2:5000", "\t cubic wscale:7,7 rto:204", "tcp ESTAB 0 0 10.0.0.1:23 10.0.0.2:5001"].join("\n");
    expect((parseSs("ss", ["-ti"], raw) as Rows).connections).toHaveLength(2);
  });
});

describe("parseSs()", () => {
  const raw = [
    "Netid  State   Recv-Q  Send-Q  Local Address:Port   Peer Address:Port",
    "tcp    LISTEN  0       128     0.0.0.0:22            0.0.0.0:*",
    "tcp    ESTAB   0       0       192.168.1.10:22       192.168.1.5:51234",
  ].join("\n");

  it("연결 목록을 파싱한다", () => {
    const result = parseSs("ss", ["-tuln"], raw) as { connections: Array<{ netid: string; state: string; local_port: string }> };
    expect(result.connections).toHaveLength(2);
    expect(result.connections[0].netid).toBe("tcp");
    expect(result.connections[0].state).toBe("LISTEN");
    expect(result.connections[0].local_port).toBe("22");
  });

  it("콜론 없는 주소는 local_port 빈 문자열", () => {
    const noPort = [
      "Netid  State   Recv-Q  Send-Q  Local Address:Port   Peer Address:Port",
      "tcp    LISTEN  0       0       *                   *",
    ].join("\n");
    const result = parseSs("ss", [], noPort) as { connections: Array<{ local_port: string; peer_port: string }> };
    expect(result.connections[0].local_port).toBe("");
    expect(result.connections[0].peer_port).toBe("");
  });

  it("5컬럼 행(peer 없음)은 splitAddr에 빈 문자열 전달", () => {
    const fiveCols = [
      "Netid  State   Recv-Q  Send-Q  Local Address:Port",
      "tcp    LISTEN  0       0       127.0.0.1:8080",
    ].join("\n");
    const result = parseSs("ss", [], fiveCols) as { connections: Array<{ local_address: string; local_port: string; peer_address: string; peer_port: string }> };
    expect(result.connections).toHaveLength(1);
    expect(result.connections[0].local_address).toBe("127.0.0.1");
    expect(result.connections[0].local_port).toBe("8080");
    expect(result.connections[0].peer_address).toBe("");
    expect(result.connections[0].peer_port).toBe("");
  });
});
