import { describe, it, expect } from "vitest";
import { parseFree }  from "../../src/parsers/system/free.js";
import { parseUname } from "../../src/parsers/system/uname.js";
import { parseId }    from "../../src/parsers/system/id.js";

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
});

describe("parseUname()", () => {
  const raw = "Linux myhostname 5.15.0-91-generic #101-Ubuntu SMP Tue Nov 14 13:30:08 UTC 2023 x86_64 x86_64 x86_64 GNU/Linux";

  it("커널 정보를 파싱한다", () => {
    const result = parseUname("uname", ["-a"], raw);
    expect(result.kernel_name).toBe("Linux");
    expect(result.hostname).toBe("myhostname");
    expect(result.kernel_release).toBe("5.15.0-91-generic");
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
