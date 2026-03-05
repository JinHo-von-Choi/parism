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
});
