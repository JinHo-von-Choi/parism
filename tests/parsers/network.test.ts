import { describe, it, expect } from "vitest";
import { parsePing } from "../../src/parsers/network/ping.js";

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
    };
    expect(result.target).toBe("google.com");
    expect(result.packets_transmitted).toBe(2);
    expect(result.packets_received).toBe(2);
    expect(result.packet_loss_percent).toBe(0);
  });
});
