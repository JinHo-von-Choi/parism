import { describe, expect, it } from "vitest";
import { inspectOutput } from "../../src/cli/inspect.js";
import { runFixtureTests } from "../../src/cli/test-runner.js";
import { createRegistry } from "../../src/parsers/index.js";
import ipPack from "../../src/parsers/network/ip.js";

const REPRESENTATIVE_OUTPUT = [
  "1: lo: <LOOPBACK,UP,LOWER_UP> mtu 65536 qdisc noqueue state UNKNOWN group default qlen 1000",
  "    link/loopback 00:00:00:00:00:00 brd 00:00:00:00:00:00",
  "    inet 127.0.0.1/8 scope host lo",
  "       valid_lft forever preferred_lft forever",
  "    inet6 ::1/128 scope host noprefixroute",
  "       valid_lft forever preferred_lft forever",
  "2: eth0@if7: <BROADCAST,MULTICAST,UP,LOWER_UP> mtu 1500 qdisc noqueue state UP group default link-netnsid 0",
  "    link/ether 02:42:ac:11:00:02 brd ff:ff:ff:ff:ff:ff link-netnsid 0",
  "    inet 172.17.0.2/16 brd 172.17.255.255 scope global eth0",
  "       valid_lft forever preferred_lft forever",
  "    inet6 fe80::42:acff:fe11:2/64 scope link",
  "       valid_lft forever preferred_lft forever",
].join("\n");

describe("ip address parser pack", () => {
  it("대표 출력을 인터페이스와 주소 구조로 파싱한다", () => {
    expect(ipPack.parse(REPRESENTATIVE_OUTPUT, ["address", "show"])).toEqual({
      interfaces: [
        {
          name: "lo",
          state: "UNKNOWN",
          mac: "00:00:00:00:00:00",
          ipv4: ["127.0.0.1/8"],
          ipv6: ["::1/128"],
        },
        {
          name: "eth0",
          state: "UP",
          mac: "02:42:ac:11:00:02",
          ipv4: ["172.17.0.2/16"],
          ipv6: ["fe80::42:acff:fe11:2/64"],
        },
      ],
    });
  });

  it("빈 출력은 정상적인 빈 결과다", () => {
    expect(ipPack.parse("\n", ["addr", "show"])).toEqual({ interfaces: [] });
  });

  it("비어 있지 않은 비정상 출력은 unrecognized_output이다", () => {
    const result = createRegistry().parse("ip", ["address", "show"], "not an ip address listing");
    expect(result.parsed).toBeNull();
    expect(result.parse_error?.reason).toBe("unrecognized_output");
  });

  it("address 외 ip 출력은 지원 범위 밖이다", () => {
    const result = createRegistry().parse("ip", ["route", "show"], "default via 192.0.2.1 dev eth0");
    expect(result.parse_error?.reason).toBe("unsupported_format");
  });

  it("스키마와 내장 fixture가 함께 검증된다", () => {
    const result = runFixtureTests(ipPack);
    expect(result.total).toBeGreaterThanOrEqual(2);
    expect(result.failed).toBe(0);
    expect(result.errored).toBe(0);
  });

  it("maxItems를 지키면서 전체 개수를 보존한다", () => {
    expect(ipPack.parse(REPRESENTATIVE_OUTPUT, ["address"], { maxItems: 1, format: "json" })).toMatchObject({
      interfaces: [{ name: "lo" }],
      _summary: { total: 2, shown: 1, truncated: true },
    });
  });

  it("compact 출력은 대표 원문보다 적은 토큰을 쓴다", () => {
    const result = inspectOutput("ip", ["address", "show"], REPRESENTATIVE_OUTPUT, createRegistry());
    expect(result.compact).not.toBeNull();
    expect(result.tokens.compact).toBeLessThan(result.tokens.raw);
  });
});
