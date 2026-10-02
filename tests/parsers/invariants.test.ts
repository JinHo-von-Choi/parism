import { describe, it, expect } from "vitest";
import { checkInvariants, countDataLines, countRowLines } from "../../src/parsers/invariants.js";
import type { ParserContract }                          from "../../src/parsers/registry.js";
import { createRegistry }                               from "../../src/parsers/index.js";

const TABLE: ParserContract = { headerLines: 1, noise: /^total /, rowsKey: "rows", rowFields: ["name", "size"] };

const rules = (parsed: unknown, raw: string, contract: ParserContract = TABLE): string[] =>
  checkInvariants(parsed, raw, contract).map(v => v.rule);

describe("데이터 줄 계산", () => {
  it("머리 줄과 noise 줄을 빼고 센다", () => {
    expect(countDataLines("NAME SIZE\na 1\n\ntotal 1\nb 2\n", TABLE)).toBe(2);
  });

  it("rowLine이 있으면 그 패턴의 줄만 행으로 센다", () => {
    const contract: ParserContract = { rowsKey: "rows", rowLine: /^(tcp|udp)\s/ };
    expect(countRowLines("tcp 0 a\nunix 2 b\nudp 0 c\n", contract)).toBe(2);
  });
});

describe("checkInvariants()", () => {
  it("행 수가 데이터 줄 수와 같고 값이 정상이면 위반이 없다", () => {
    const parsed = { rows: [{ name: "a", size: 1 }, { name: "b", size: 2 }] };
    expect(rules(parsed, "NAME SIZE\na 1\nb 2\n")).toEqual([]);
  });

  it("데이터 줄이 있는데 행이 비면 silent_empty", () => {
    expect(rules({ rows: [] }, "NAME SIZE\na 1\n")).toEqual(["silent_empty"]);
  });

  it("행 배열이 없는 결과도 데이터 줄이 있는데 모든 값이 기본값이면 silent_empty", () => {
    expect(rules({ name: "", count: 0 }, "something\n", {})).toEqual(["silent_empty"]);
  });

  it("숫자만 있는 결과의 0은 인식한 값이다", () => {
    expect(rules({ uid: 0 }, "0\n", {})).toEqual([]);
  });

  it("행이 빠지거나 늘면 row_count", () => {
    const parsed = { rows: [{ name: "b", size: 2 }] };
    expect(rules(parsed, "NAME SIZE\na 1\nb 2\n")).toEqual(["row_count"]);
  });

  it("_summary.truncated가 있으면 total과 비교한다", () => {
    const parsed = { rows: [{ name: "a", size: 1 }], _summary: { total: 2, shown: 1, truncated: true } };
    expect(rules(parsed, "NAME SIZE\na 1\nb 2\n")).toEqual([]);
  });

  it("유한하지 않은 숫자는 non_finite", () => {
    const parsed = { rows: [{ name: "a", size: Number.NaN }] };
    expect(rules(parsed, "NAME SIZE\na x\n")).toEqual(["non_finite"]);
  });

  it("rowFields 밖의 필드는 field_names", () => {
    const parsed = { rows: [{ name: "a", size: 1, extra: true }] };
    expect(rules(parsed, "NAME SIZE\na 1\n")).toEqual(["field_names"]);
  });

  it("위반 메시지는 위치와 수치를 담는다", () => {
    const [v] = checkInvariants({ rows: [{ name: "a", size: 1 }] }, "NAME SIZE\na 1\nb 2\n", TABLE);
    expect(v).toMatchObject({ rule: "row_count", message: expect.stringContaining("1") });
  });
});

describe("내장 파서 계약에 대한 불변식", () => {
  const reg = createRegistry();

  /** 레지스트리로 파싱하고 그 명령의 계약으로 불변식을 검사한다. */
  const violations = (cmd: string, args: string[], raw: string): string[] => {
    const { parsed } = reg.parse(cmd, args, raw, { maxItems: 0, format: "json" });
    expect(parsed).not.toBeNull();
    return checkInvariants(parsed, raw, reg.contractFor(cmd, args)).map(v => `${v.rule}: ${v.message}`);
  };

  it("ls -l", () => {
    const raw = [
      "total 8",
      "-rw-r--r-- 1 u g 12 Oct  3 06:45 a.txt",
      "drwxr-xr-x 2 u g 4096 Oct  3 06:45 sub",
    ].join("\n") + "\n";
    expect(violations("ls", ["-l"], raw)).toEqual([]);
  });

  it("df", () => {
    const raw = "Filesystem 1K-blocks Used Available Use% Mounted on\n/dev/sda1 100 40 60 40% /\ntmpfs 10 0 10 0% /run\n";
    expect(violations("df", [], raw)).toEqual([]);
  });

  it("ps aux", () => {
    const raw = [
      "USER PID %CPU %MEM VSZ RSS TTY STAT START TIME COMMAND",
      "root 1 0.0 0.1 1000 200 ? Ss 10:00 0:01 /sbin/init",
      "u 42 1.5 0.2 2000 300 pts/0 R+ 10:01 0:00 ps aux",
    ].join("\n") + "\n";
    expect(violations("ps", ["aux"], raw)).toEqual([]);
  });

  it("netstat는 프로토콜 줄만 행이다", () => {
    const raw = [
      "Active Internet connections (servers and established)",
      "Proto Recv-Q Send-Q Local Address Foreign Address State",
      "tcp 0 0 0.0.0.0:22 0.0.0.0:* LISTEN",
      "udp 0 0 0.0.0.0:68 0.0.0.0:*",
      "Active UNIX domain sockets (servers and established)",
      "Proto RefCnt Flags Type State I-Node Path",
    ].join("\n") + "\n";
    expect(violations("netstat", ["-an"], raw)).toEqual([]);
  });

  it("grep -n", () => {
    expect(violations("grep", ["-n", "x", "f.txt"], "3:x one\n7:x two\n")).toEqual([]);
  });

  it("systemctl list-units는 범례와 요약 줄을 행으로 세지 않는다", () => {
    const raw = [
      "  UNIT LOAD ACTIVE SUB DESCRIPTION",
      "  cron.service loaded active running Regular background program processing daemon",
      "",
      "Legend: LOAD   -> Reflects whether the unit definition was properly loaded.",
      "        ACTIVE -> The high-level unit activation state, i.e. generalization of SUB.",
      "        SUB    -> The low-level unit activation state, values depend on unit type.",
      "",
      "1 loaded units listed.",
    ].join("\n") + "\n";
    expect(violations("systemctl", ["list-units"], raw)).toEqual([]);
  });

  it("git log --oneline", () => {
    expect(violations("git", ["log", "--oneline"], "abc1234 first\ndef5678 second\n")).toEqual([]);
  });

  it("apt list --installed는 Listing 줄을 행으로 세지 않는다", () => {
    const raw = "Listing...\nbash/noble,now 5.2-1 amd64 [installed]\nzsh/noble,now 5.9-6 amd64 [installed]\n";
    expect(violations("apt", ["list", "--installed"], raw)).toEqual([]);
  });
});

describe("인자와 출력 모양에 따른 불변식", () => {
  const reg = createRegistry();

  /** 레지스트리로 파싱하고 인자를 반영한 계약으로 불변식을 검사한다. */
  const violations = (cmd: string, args: string[], raw: string): string[] => {
    const { parsed, parse_error } = reg.parse(cmd, args, raw, { maxItems: 0, format: "json" });
    expect(parse_error).toBeUndefined();
    return checkInvariants(parsed, raw, reg.contractFor(cmd, args)).map(v => `${v.rule}: ${v.message}`);
  };

  it("git log --decorate의 refs", () => {
    expect(violations("git", ["log", "--oneline", "--decorate"], "abc1234 (HEAD -> main, tag: v1.0) first\ndef5678 second\n")).toEqual([]);
  });

  it("git branch의 detached, points_to, worktree", () => {
    expect(violations("git", ["branch", "-v"], "* (HEAD detached at abc1234) abc1234 msg\n  main    def5678 other\n")).toEqual([]);
    expect(violations("git", ["branch", "-av"], "* main                abc1234 msg\n  remotes/origin/HEAD -> origin/main\n  remotes/origin/main abc1234 msg\n")).toEqual([]);
    expect(violations("git", ["branch", "-v"], "+ wt   abc1234 msg\n* main abc1234 msg\n")).toEqual([]);
  });

  it("git diff의 status, old_path, binary", () => {
    const raw = [
      "diff --git a/old.txt b/new.txt",
      "similarity index 90%",
      "rename from old.txt",
      "rename to new.txt",
      "index 1111111..2222222 100644",
      "--- a/old.txt",
      "+++ b/new.txt",
      "@@ -1 +1 @@",
      "-a",
      "+b",
      "diff --git a/img.png b/img.png",
      "new file mode 100644",
      "index 0000000..3333333",
      "Binary files /dev/null and b/img.png differ",
    ].join("\n") + "\n";
    expect(violations("git", ["diff", "-M", "HEAD~1"], raw)).toEqual([]);
  });

  it("NUL로 끝나는 행(find -print0, du -0, grep -Z -l)은 NUL로 센다", () => {
    expect(violations("find", [".", "-print0"], "./a\0./b c\0./d\ne\0")).toEqual([]);
    expect(violations("du", ["-0"], "4\t./a\x004\t./b\0")).toEqual([]);
    expect(violations("du", ["-s0"], "8\t.\0")).toEqual([]);
    expect(violations("grep", ["-Z", "-l", "m", "a", "b"], "a\0b\0")).toEqual([]);
    expect(violations("grep", ["-lZ", "m", "a", "b"], "a\0b\0")).toEqual([]);
  });

  it("ps의 머리 줄은 위치가 아니라 모양으로 가린다(--no-headers, --headers)", () => {
    const row1 = "root 1 0.0 0.1 1000 200 ? Ss 10:00 0:01 /sbin/init";
    const row2 = "u 42 1.5 0.2 2000 300 pts/0 R+ 10:01 0:00 ps aux";
    const head = "USER PID %CPU %MEM VSZ RSS TTY STAT START TIME COMMAND";
    expect(violations("ps", ["aux", "--no-headers"], `${row1}\n${row2}\n`)).toEqual([]);
    expect(violations("ps", ["aux", "--headers"], `${head}\n${row1}\n${head}\n${row2}\n`)).toEqual([]);
  });

  it("JSON 배열 출력은 원소 수가 행 수다(gh pr list --json)", () => {
    expect(violations("gh", ["pr", "list", "--json", "number,title"], "[]\n")).toEqual([]);
    const raw = JSON.stringify([{ number: 1, title: "a" }, { number: 2, title: "b" }], null, 2) + "\n";
    expect(violations("gh", ["pr", "list", "--json", "number,title"], raw)).toEqual([]);
  });
});
