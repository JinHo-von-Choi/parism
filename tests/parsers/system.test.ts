import { describe, it, expect } from "vitest";
import { parseFree }       from "../../src/parsers/system/free.js";
import { supportsFree }    from "../../src/parsers/supports.js";
import { parseUname }      from "../../src/parsers/system/uname.js";
import { parseId }         from "../../src/parsers/system/id.js";
import { parseSystemctl }  from "../../src/parsers/system/systemctl.js";
import { parseJournalctl } from "../../src/parsers/system/journalctl.js";
import { parseApt }         from "../../src/parsers/system/apt.js";
import { parseBrew }       from "../../src/parsers/system/brew.js";

describe("free 단위 처리 범위", () => {
  it("10진 단위 옵션은 supportsFree가 거부하고 2진 단위 옵션은 환산한다", () => {
    for (const flag of ["--kilo", "--mega", "--giga"]) expect(supportsFree([flag])).toBe(false);
    const raw = "              total        used        free      shared  buff/cache   available\nMem:             10           4           6           0           0           6\n";
    expect(parseFree("free", ["--mebi"], raw)).toMatchObject({ unit: "MB", mem: { total_bytes: 10 * 1024 ** 2 } });
    expect(parseFree("free", [], raw)).toMatchObject({ unit: "KB", mem: { total_bytes: 10 * 1024 } });
  });
});

describe("parseFree()", () => {
  const raw = [
    "               total        used        free      shared  buff/cache   available",
    "Mem:           15845        3421        8234         412        4189       11634",
    "Swap:           2047           0        2047",
  ].join("\n");

  it("메모리 사용량을 파싱한다", () => {
    const result = parseFree("free", ["-m"], raw);
    expect(result.mem.total).toBe(15845);
    expect(result.mem.used).toBe(3421);
    expect(result.mem.available).toBe(11634);
    expect(result.swap?.total).toBe(2047);
    expect(result.unit).toBe("MB");
  });

  it("-g 사용 시 unit이 GB다", () => {
    const result = parseFree("free", ["-g"], raw);
    expect(result.unit).toBe("GB");
  });

  it("-k 사용 시 unit이 KB다", () => {
    const result = parseFree("free", ["-k"], raw);
    expect(result.unit).toBe("KB");
  });

  it("-m/-g/-k 없으면 unit이 KB다", () => {
    const result = parseFree("free", [], raw);
    expect(result.unit).toBe("KB");
  });

  it("단위 플래그 없는 free는 KiB를 bytes로 환산한다", () => {
    const one = "              total        used        free      shared  buff/cache   available\nMem:        1000          10         990           0           0         990\n";
    const r   = parseFree("free", [], one);
    expect(r.mem.total_bytes).toBe(1024000);
    expect(r.mem.available_bytes).toBe(990 * 1024);
  });

  it("-m 은 MiB, -b 는 그대로 bytes로 환산한다", () => {
    expect(parseFree("free", ["-m"], raw).mem.total_bytes).toBe(15845 * 1024 ** 2);
    expect(parseFree("free", ["-b"], raw).mem.total_bytes).toBe(15845);
  });

  it("Mem/Swap 행 없으면 0과 null", () => {
    const noMem = "total used free\n1 2 3";
    const result = parseFree("free", ["-m"], noMem);
    expect(result.mem.total).toBe(0);
    expect(result.mem.used).toBe(0);
    expect(result.swap).toBeNull();
  });
});

describe("parseUname()", () => {
  const raw = "Linux myhostname 5.15.0-91-generic #101-Ubuntu SMP Tue Nov 14 13:30:08 UTC 2023 x86_64 x86_64 x86_64 GNU/Linux";

  it("커널 정보를 파싱한다", () => {
    const result = parseUname("uname", ["-a"], raw);
    expect(result.kernel_name).toBe("Linux");
    expect(result.hostname).toBe("myhostname");
    expect(result.kernel_release).toBe("5.15.0-91-generic");
  });

  it("x86_64 없을 때 kernel_version 파싱", () => {
    const noArch = "Linux host 5.10.0 #1 SMP aarch64 aarch64 GNU/Linux";
    const result = parseUname("uname", ["-a"], noArch);
    expect(result.machine).toBe("aarch64");
    expect(result.os).toBe("GNU/Linux");
  });

  it("x86_64 있을 때 kernel_version은 lastIndexOf(x86_64) 직전까지", () => {
    const result = parseUname("uname", ["-a"], raw);
    expect(result.kernel_version).toContain("#101-Ubuntu");
    expect(result.machine).toBe("x86_64");
    expect(result.os).toBe("GNU/Linux");
  });

  it("입력이 짧을 때 빈 문자열로 채움", () => {
    const result = parseUname("uname", [], "Linux");
    expect(result.kernel_name).toBe("Linux");
    expect(result.hostname).toBe("");
    expect(result.kernel_release).toBe("");
    expect(result.machine).toBe("");
    expect(result.os).toBe("Linux");
  });
});

describe("parseUname() -a 끝에서부터 할당", () => {
  it("kernel_version 은 공백을 포함하고 machine 과 os 는 끝에서 정해진다", () => {
    const r = parseUname("uname", ["-a"], "Linux h 6.8.0-1 #1 SMP PREEMPT_DYNAMIC Tue Nov 14 13:30:08 UTC 2023 x86_64 x86_64 x86_64 GNU/Linux");
    expect(r).toMatchObject({ kernel_name: "Linux", hostname: "h", kernel_release: "6.8.0-1", machine: "x86_64", os: "GNU/Linux" });
    expect(r.kernel_version).toBe("#1 SMP PREEMPT_DYNAMIC Tue Nov 14 13:30:08 UTC 2023");
  });

  it("Linux 가 아닌 커널은 끝이 machine 이다", () => {
    const r = parseUname("uname", ["-a"], "Darwin m 23.1.0 Darwin Kernel Version 23.1.0: Mon Oct 9 RELEASE_ARM64_T6000 arm64");
    expect(r).toMatchObject({ kernel_name: "Darwin", machine: "arm64", os: "" });
    expect(r.kernel_version.endsWith("RELEASE_ARM64_T6000")).toBe(true);
  });
});

describe("parseId() 단일 값", () => {
  it("id -u 는 uid 한 값만 반환한다", () => {
    expect(parseId("id", ["-u"], "1000\n")).toEqual({ uid: 1000 });
  });
  it("id -g 와 id -G", () => {
    expect(parseId("id", ["-g"], "1000\n")).toEqual({ gid: 1000 });
    expect(parseId("id", ["-G"], "1000 4 27\n")).toEqual({ groups: [1000, 4, 27] });
  });
});

describe("parseId()", () => {
  const raw = "uid=1000(nirna) gid=1000(nirna) groups=1000(nirna),4(adm),27(sudo)";

  it("사용자 정보를 파싱한다", () => {
    const result = parseId("id", [], raw);
    expect(result.uid).toBe(1000);
    expect(result.user).toBe("nirna");
    expect(result.groups.map(g => g.name)).toContain("sudo");
  });

  it("uid/gid 형식 불일치 시 0과 빈 문자열", () => {
    const result = parseId("id", [], "invalid format");
    expect(result.uid).toBe(0);
    expect(result.user).toBe("");
    expect(result.gid).toBe(0);
    expect(result.group).toBe("");
  });

  it("groups 없으면 빈 배열", () => {
    const result = parseId("id", [], "uid=1000(nirna) gid=1000(nirna)");
    expect(result.groups).toEqual([]);
  });

  it("groups 배열에 uid/gid가 중복 포함되지 않는다", () => {
    const result = parseId("id", [], raw);
    // uid=1000, gid=1000 은 groups 파싱 대상이 아님 — groups= 섹션만 파싱
    const names = result.groups.map(g => g.name);
    // "nirna"가 groups에 한 번만 등장해야 함
    expect(names.filter(n => n === "nirna")).toHaveLength(1);
    // groups 수는 실제 그룹 수(3)여야 함
    expect(result.groups).toHaveLength(3);
  });
});

describe("parseSystemctl()", () => {
  const raw = [
    "  UNIT                                                                                      LOAD      ACTIVE SUB     DESCRIPTION",
    "  accounts-daemon.service                                                                   loaded    active  running Accounts Service",
    "  docker.service                                                                            loaded    active  running Docker Application Container Engine",
    "● apparmor.service                                                                          loaded    failed  failed  Load AppArmor profiles",
  ].join("\n");

  it("빈 입력 시 units 빈 배열", () => {
    const result = parseSystemctl("systemctl", [], "") as { units: unknown[] };
    expect(result.units).toEqual([]);
  });

  it("list-units 출력을 파싱한다", () => {
    const result = parseSystemctl("systemctl", ["list-units"], raw) as { units: Array<{ name: string; load: string; active: string; sub: string; description: string; failed?: boolean }> };
    expect(result.units).toHaveLength(3);
    expect(result.units[0].name).toBe("accounts-daemon.service");
    expect(result.units[0].load).toBe("loaded");
    expect(result.units[0].active).toBe("active");
    expect(result.units[0].sub).toBe("running");
    expect(result.units[0].description).toBe("Accounts Service");
    expect(result.units[2].failed).toBe(true);
  });

  it("JOB 열이 있으면 job과 description을 열 위치로 분리한다", () => {
    const withJob = [
      "  UNIT             LOAD   ACTIVE   SUB     JOB   DESCRIPTION",
      "  cron.service     loaded active   running       Regular background program",
      "  apt-daily.timer  loaded inactive dead    start Daily apt download activities",
    ].join("\n");
    const result = parseSystemctl("systemctl", ["list-units"], withJob) as { units: Array<{ name: string; sub: string; job?: string; description: string }> };
    expect(result.units).toHaveLength(2);
    expect(result.units[0]).toMatchObject({ name: "cron.service", sub: "running", description: "Regular background program" });
    expect(result.units[0].job).toBeUndefined();
    expect(result.units[1]).toMatchObject({ name: "apt-daily.timer", job: "start", description: "Daily apt download activities" });
  });

  it("헤더 없으면 { lines } 폴백", () => {
    const result = parseSystemctl("systemctl", [], "line1\nline2") as { lines: string[] };
    expect(result.lines).toEqual(["line1", "line2"]);
  });

  it("maxItems 초과 시 truncation", () => {
    const many = Array.from({ length: 10 }, (_, i) =>
      `  unit${i}.service    loaded    active  running Unit ${i}`,
    ).join("\n");
    const raw = "  UNIT                                                                  LOAD   ACTIVE SUB     DESCRIPTION\n" + many;
    const result = parseSystemctl("systemctl", ["list-units"], raw, { maxItems: 3, format: "json" }) as {
      units: unknown[];
    };
    expect(result.units).toHaveLength(3);
  });
});

describe("parseJournalctl()", () => {
  const raw = [
    "2026-03-07T21:18:08+09:00 nerdvana node[2032810]: [12:18:08.468] WARN: Redis client connection closed",
    "2026-03-07T21:18:04+09:00 nerdvana postfix/postdrop[1549111]: warning: unable to look up public/pickup",
  ].join("\n");

  it("빈 입력 시 entries 빈 배열", () => {
    const result = parseJournalctl("journalctl", [], "") as { entries: unknown[] };
    expect(result.entries).toEqual([]);
  });

  it("short-iso 출력을 파싱한다", () => {
    const result = parseJournalctl("journalctl", ["-o", "short-iso", "-n", "10"], raw) as { entries: Array<{ timestamp: string; hostname: string; unit: string; pid?: number; message: string }> };
    expect(result.entries).toHaveLength(2);
    expect(result.entries[0].timestamp).toBe("2026-03-07T21:18:08+09:00");
    expect(result.entries[0].hostname).toBe("nerdvana");
    expect(result.entries[0].unit).toBe("node");
    expect(result.entries[0].pid).toBe(2032810);
    expect(result.entries[0].message).toContain("WARN");
  });

  it("ISO 타임스탬프 없으면 { lines } 폴백", () => {
    const result = parseJournalctl("journalctl", [], "plain text\nno timestamp") as { lines: string[] };
    expect(result.lines).toEqual(["plain text", "no timestamp"]);
  });

  it("maxItems 초과 시 truncation", () => {
    const many = Array.from({ length: 10 }, (_, i) =>
      `2026-03-07T12:00:00+09:00 host unit[${i}]: msg ${i}`,
    ).join("\n");
    const result = parseJournalctl("journalctl", [], many, { maxItems: 3, format: "json" }) as { entries: unknown[] };
    expect(result.entries).toHaveLength(3);
  });
});

describe("parseApt()", () => {
  const raw = [
    "나열 중...",
    "7zip/noble-apps-security,now 23.01+dfsg-11ubuntu0.1~esm1 amd64 [설치됨,자동]",
    "docker-ce/jammy,now 5:27.1.0-1~ubuntu.22.04~jammy amd64 [설치됨,자동]",
  ].join("\n");

  it("apt list --installed 출력을 파싱한다", () => {
    const result = parseApt("apt", ["list", "--installed"], raw) as { packages: Array<{ name: string; version: string; arch: string }> };
    expect(result.packages).toHaveLength(2);
    expect(result.packages[0]?.name).toBe("7zip");
    expect(result.packages[0]).toMatchObject({ suite: "noble-apps-security" });
    expect(result.packages[0]?.version).toContain("23.01");
    expect(result.packages[0]?.arch).toBe("amd64");
  });

  it("파싱 불가 시 { lines } 폴백", () => {
    const result = parseApt("apt", [], "invalid format\n") as { lines: string[] };
    expect(result.lines).toEqual(["invalid format"]);
  });

  it("maxItems 초과 시 truncation", () => {
    const result = parseApt("apt", ["list"], raw, { maxItems: 1 }) as { packages: unknown[] };
    expect(result.packages).toHaveLength(1);
  });
});

describe("parseBrew()", () => {
  const raw = "node 22.0.0\ngit 2.43.0\nnginx 1.24.0";

  it("brew list --versions 출력을 파싱한다", () => {
    const result = parseBrew("brew", ["list", "--versions"], raw) as { packages: Array<{ name: string; version: string }> };
    expect(result.packages).toHaveLength(3);
    expect(result.packages[0]?.name).toBe("node");
    expect(result.packages[0]?.version).toBe("22.0.0");
  });

  it("파싱 불가 시 { lines } 폴백", () => {
    const result = parseBrew("brew", [], "single\nword\n") as { lines: string[] };
    expect(result.lines).toEqual(["single", "word"]);
  });

  it("maxItems 초과 시 truncation", () => {
    const result = parseBrew("brew", ["list"], raw, { maxItems: 1 }) as { packages: unknown[] };
    expect(result.packages).toHaveLength(1);
  });
});
