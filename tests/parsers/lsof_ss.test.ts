import { describe, it, expect } from "vitest";
import { parseLsof } from "../../src/parsers/network/lsof.js";
import { parseSs }   from "../../src/parsers/network/ss.js";

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
