import { describe, it, expect } from "vitest";
import { parsePing }   from "../../src/parsers/network/ping.js";
import { parseCurl }   from "../../src/parsers/network/curl.js";
import { parseNetstat } from "../../src/parsers/network/netstat.js";
import { UnrecognizedOutputError } from "../../src/parsers/registry.js";

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

  it("-I 사용 시 상태 줄이 없으면 값을 만들지 않는다", () => {
    expect(() => parseCurl("curl", ["-I", "https://x.com"], "Invalid response\nContent-Type: text/plain\n")).toThrow(UnrecognizedOutputError);
    expect(() => parseCurl("curl", ["-sI", "https://no-such-host.invalid"], "")).toThrow(UnrecognizedOutputError);
  });

  it("리다이렉트를 따라간 응답은 최종 응답을 본문으로 하고 앞선 응답을 history에 담는다", () => {
    const raw = ["HTTP/1.1 301 Moved Permanently", "Location: https://x.com/", "", "HTTP/2 200", "content-type: text/html", ""].join("\r\n");
    const r = parseCurl("curl", ["-sIL", "http://x.com"], raw) as { status_code: number; status_text: string; history: Array<{ status_code: number; headers: Record<string, string> }> };
    expect(r).toMatchObject({ status_code: 200, status_text: "" });
    expect(r.history).toHaveLength(1);
    expect(r.history[0]).toMatchObject({ status_code: 301, headers: { location: "https://x.com/" } });
  });

  it("같은 이름의 헤더가 반복되면 값을 잇고 header_values에 모두 담는다", () => {
    const raw = ["HTTP/2 200", "set-cookie: a=1", "set-cookie: b=2", "server: x"].join("\n");
    const r = parseCurl("curl", ["-sI", "https://x.com"], raw) as { headers: Record<string, string>; header_values: Record<string, string[]> };
    expect(r.headers["set-cookie"]).toBe("a=1, b=2");
    expect(r.header_values).toEqual({ "set-cookie": ["a=1", "b=2"] });
    expect(r.headers["server"]).toBe("x");
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

  it("UDP 행은 state 를 null 로 둔다", () => {
    const raw = [
      "Active Internet connections (servers and established)",
      "Proto Recv-Q Send-Q Local Address           Foreign Address         State       PID/Program name",
      "udp        0      0 0.0.0.0:68              0.0.0.0:*                           812/dhclient",
      "udp        0      0 0.0.0.0:5353            0.0.0.0:*                           -",
    ].join("\n");
    const r = parseNetstat("netstat", ["-aup"], raw);
    expect(r.connections[0]).toMatchObject({ proto: "udp", local_address: "0.0.0.0:68", state: null });
    expect(r.connections[1]).toMatchObject({ state: null });
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

  it("통계 줄이 없으면 값을 만들지 않는다", () => {
    expect(() => parsePing("ping", [], "invalid output")).toThrow(UnrecognizedOutputError);
    expect(() => parsePing("ping", ["no-such-host.invalid"], "")).toThrow(UnrecognizedOutputError);
  });

  it("오류와 중복 개수 구획을 건너뛰고 소수 손실률을 읽는다", () => {
    const r = parsePing("ping", ["h"], "PING h (10.0.0.1) 56(84) bytes of data.\n--- h ping statistics ---\n3 packets transmitted, 2 received, +1 errors, 33% packet loss, time 2ms\n") as { packets_received: number; packet_loss_percent: number };
    expect(r).toMatchObject({ packets_received: 2, packet_loss_percent: 33 });
    const mac = parsePing("ping", ["h"], "PING h (10.0.0.1): 56 data bytes\n--- h ping statistics ---\n3 packets transmitted, 2 packets received, 33.3% packet loss\nround-trip min/avg/max/stddev = 1.0/2.0/3.0/0.5 ms\n") as { packet_loss_percent: number; rtt_avg_ms: number };
    expect(mac).toMatchObject({ packet_loss_percent: 33.3, rtt_avg_ms: 2 });
  });
});
