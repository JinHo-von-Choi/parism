import { describe, it, expect } from "vitest";
import { parsePs } from "../../src/parsers/process/ps.js";

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
});
