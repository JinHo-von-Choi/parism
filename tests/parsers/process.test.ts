import { describe, it, expect } from "vitest";
import { parsePs }  from "../../src/parsers/process/ps.js";
import { parseKill } from "../../src/parsers/process/kill.js";

describe("parseKill()", () => {
  it("raw를 그대로 반환한다", () => {
    const result = parseKill("kill", ["-l"], "");
    expect(result).toEqual({ raw: "" });
  });
});

describe("parsePs() 형식 변형", () => {
  const header = "USER         PID %CPU %MEM    VSZ   RSS TTY      STAT START   TIME COMMAND";
  type Rows = { processes: Array<{ pid: number; command: string; depth?: number }> };

  it("--no-headers 출력의 첫 줄도 프로세스로 읽는다", () => {
    const r = parsePs("ps", ["aux", "--no-headers"], "root           1  0.3  0.0  25880 16108 ?        Ss   Sep04 138:06 /usr/lib/systemd/systemd --system\n") as Rows;
    expect(r.processes).toHaveLength(1);
    expect(r.processes[0]).toMatchObject({ pid: 1, command: "/usr/lib/systemd/systemd --system" });
  });

  it("--headers가 되풀이하는 머리 줄은 행이 아니다", () => {
    const row = "root           1  0.3  0.0  25880 16108 ?        Ss   Sep04 138:06 init";
    expect((parsePs("ps", ["aux", "--headers"], [header, row, header, row].join("\n")) as Rows).processes).toHaveLength(2);
  });

  it("트리 출력은 가지를 떼고 깊이를 담는다", () => {
    const raw = [
      header,
      "root           2  0.0  0.0      0     0 ?        S    Sep04   0:40 [kthreadd]",
      "root           3  0.0  0.0      0     0 ?        S    Sep04   0:00  \\_ [pool_workqueue_release]",
      "git      1519366  0.0  0.0 608728 33284 ?        Ssl  Sep26   0:13  |   \\_ ruby app",
      "git      1519928 34.6  1.2 4087944 1644204 ?     Sl   Sep26 3553:18  |       \\_ sidekiq 7.3.9",
    ].join("\n");
    const r = parsePs("ps", ["auxf"], raw) as Rows;
    expect(r.processes.map(p => [p.pid, p.depth, p.command])).toEqual([
      [2, 0, "[kthreadd]"], [3, 1, "[pool_workqueue_release]"], [1519366, 2, "ruby app"], [1519928, 3, "sidekiq 7.3.9"],
    ]);
  });

  it("가지 표시가 없는 f 없는 출력은 command를 그대로 둔다", () => {
    const r = parsePs("ps", ["aux"], `${header}\nroot 2 0.0 0.0 0 0 ? S Sep04 0:40 \\_ odd name\n`) as Rows;
    expect(r.processes[0]!.command).toBe("\\_ odd name");
    expect(r.processes[0]!.depth).toBeUndefined();
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
      `user ${1000 + i} 0.0 0.0 0 0 ? S 00:00 0:00 proc${i}`,
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
