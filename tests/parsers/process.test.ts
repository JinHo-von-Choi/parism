import { describe, it, expect } from "vitest";
import { parsePs }  from "../../src/parsers/process/ps.js";
import { parseKill } from "../../src/parsers/process/kill.js";

describe("parseKill()", () => {
  it("raw를 그대로 반환한다", () => {
    const result = parseKill("kill", ["-l"], "");
    expect(result).toEqual({ raw: "" });
  });
});

describe("parsePs()", () => {
  const psOutput = [
    "USER       PID %CPU %MEM    VSZ   RSS TTY      STAT START   TIME COMMAND",
    "root         1  0.0  0.1 168820 11216 ?        Ss   Mar05   0:03 /sbin/init",
    "user      1234  0.5  2.1 512340 87432 pts/0    S+   09:23   0:01 node server.js",
  ].join("\n");

  it("프로세스 목록을 파싱한다", () => {
    const result = parsePs("ps", ["aux"], psOutput) as { processes: Array<{ pid: number; command: string }> };
    expect(result.processes).toHaveLength(2);
    expect(result.processes[1].pid).toBe(1234);
    expect(result.processes[1].command).toContain("node");
  });

  it("maxItems 초과 시 _summary와 truncation을 반환한다", () => {
    const many = Array.from({ length: 10 }, (_, i) =>
      `user ${i} ${1000 + i} 0.0 0.0 0 0 ? S 00:00 0:00 proc${i}`,
    ).join("\n");
    const raw = "USER       PID %CPU %MEM    VSZ   RSS TTY      STAT START   TIME COMMAND\n" + many;
    const result = parsePs("ps", ["aux"], raw, { maxItems: 3, format: "json" }) as {
      processes: unknown[];
      _summary: { total: number; shown: number; truncated: boolean };
    };
    expect(result.processes).toHaveLength(3);
    expect(result._summary.total).toBe(10);
    expect(result._summary.truncated).toBe(true);
  });
});
