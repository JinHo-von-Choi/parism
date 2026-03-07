import { describe, it, expect } from "vitest";
import { parsePing }   from "../../src/parsers/network/ping.js";
import { parseCurl }   from "../../src/parsers/network/curl.js";
import { parseNetstat } from "../../src/parsers/network/netstat.js";

describe("parseCurl()", () => {
  it("-I 사용 시 status_code와 headers를 파싱한다", () => {
    const raw    = [
      "HTTP/1.1 200 OK",
      "Content-Type: application/json",
      "Content-Length: 42",
    ].join("\n");
    const result = parseCurl("curl", ["-I", "https://example.com"], raw) as {
      status_code: number;
      status_text: string;
      headers: Record<string, string>;
    };
    expect(result.status_code).toBe(200);
    expect(result.status_text).toBe("OK");
    expect(result.headers["content-type"]).toBe("application/json");
  });

  it("-I 사용 시 statusLine 형식 불일치면 0과 빈 문자열", () => {
    const raw    = "Invalid response\nContent-Type: text/plain\n";
    const result = parseCurl("curl", ["-I", "https://x.com"], raw) as {
      status_code: number;
      status_text: string;
      headers: Record<string, string>;
    };
    expect(result.status_code).toBe(0);
    expect(result.status_text).toBe("");
    expect(result.headers["content-type"]).toBe("text/plain");
  });

  it("-I 없을 때 raw를 반환한다", () => {
    const raw    = "some body content";
    const result = parseCurl("curl", ["https://example.com"], raw) as { raw: string };
    expect(result.raw).toBe("some body content");
  });
});

describe("parseNetstat()", () => {
  const netstatLinuxRaw = [
    "Active Internet connections (w/o servers)",
    "Proto Recv-Q Send-Q Local Address           Foreign Address         State",
    "tcp        0      0 0.0.0.0:22              0.0.0.0:*               LISTEN",
    "tcp        0      0 127.0.0.1:5432          0.0.0.0:*               LISTEN",
  ].join("\n");

  const netstatMacosRaw = [
    "Active Internet connections",
    "Proto Recv-Q Send-Q  Local Address          Foreign Address        (state)",
    "tcp4       0      0  127.0.0.1.5432         *.*                    LISTEN",
    "tcp4       0      0  192.168.1.100.22       192.168.1.10.51234     ESTABLISHED",
  ].join("\n");

  it("Linux 형식 netstat 출력을 파싱한다", () => {
    const result = parseNetstat("netstat", ["-tuln"], netstatLinuxRaw);
    expect(result.connections).toHaveLength(2);
    expect(result.connections[0]).toMatchObject({ proto: "tcp", state: "LISTEN" });
    expect(result.connections[0]).toHaveProperty("local_address", "0.0.0.0:22");
  });

  it("macOS 형식 netstat 출력을 파싱한다", () => {
    const result = parseNetstat("netstat", ["-an"], netstatMacosRaw);
    expect(result.connections).toHaveLength(2);
    expect(result.connections[0]).toMatchObject({ proto: "tcp4", state: "LISTEN" });
    expect(result.connections[0]).toHaveProperty("local_address", "127.0.0.1.5432");
  });
});

describe("parsePing()", () => {
  const pingOutput = [
    "PING google.com (142.250.196.110) 56(84) bytes of data.",
    "64 bytes from lax31s01-in-f14.1e100.net (142.250.196.110): icmp_seq=1 ttl=116 time=12.3 ms",
    "64 bytes from lax31s01-in-f14.1e100.net (142.250.196.110): icmp_seq=2 ttl=116 time=11.8 ms",
    "",
    "--- google.com ping statistics ---",
    "2 packets transmitted, 2 received, 0% packet loss, time 1001ms",
    "rtt min/avg/max/mdev = 11.800/12.050/12.300/0.250 ms",
  ].join("\n");

  it("ping 결과를 파싱한다", () => {
    const result = parsePing("ping", ["google.com"], pingOutput) as {
      target: string;
      packets_transmitted: number;
      packets_received: number;
      packet_loss_percent: number;
      rtt_min_ms: number | null;
    };
    expect(result.target).toBe("google.com");
    expect(result.packets_transmitted).toBe(2);
    expect(result.packets_received).toBe(2);
    expect(result.packet_loss_percent).toBe(0);
    expect(result.rtt_min_ms).toBe(11.8);
  });

  it("rtt 없음(100% 패킷 손실) 시 null 반환", () => {
    const noRtt = [
      "PING unreachable.local (192.168.99.99) 56(84) bytes of data.",
      "3 packets transmitted, 0 received, 100% packet loss",
    ].join("\n");
    const result = parsePing("ping", ["unreachable.local"], noRtt);
    expect(result.rtt_min_ms).toBeNull();
    expect(result.packet_loss_percent).toBe(100);
  });

  it("형식 불일치 시 기본값 반환", () => {
    const result = parsePing("ping", [], "invalid output");
    expect(result.target).toBe("");
    expect(result.packets_transmitted).toBe(0);
  });
});
