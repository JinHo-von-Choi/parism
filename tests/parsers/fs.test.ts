import { describe, it, expect } from "vitest";
import { parseLs }   from "../../src/parsers/fs/ls.js";
import { parseFind } from "../../src/parsers/fs/find.js";
import { parseDu }   from "../../src/parsers/fs/du.js";
import { parseDf }   from "../../src/parsers/fs/df.js";

describe("parseLs()", () => {
  const lsLaOutput = [
    "total 16",
    "drwxr-xr-x 3 user group 4096 Mar 06 09:23 .",
    "drwxr-xr-x 5 user group 4096 Mar 06 09:20 ..",
    "-rw-r--r-- 1 user group  512 Mar 06 09:23 README.md",
    "drwxr-xr-x 2 user group 4096 Mar 06 09:23 src",
  ].join("\n");

  it("파일 목록을 파싱한다", () => {
    const result = parseLs("ls", ["-la"], lsLaOutput) as { entries: unknown[] };
    expect(result.entries).toHaveLength(4);
    expect(result.entries[2]).toMatchObject({
      name: "README.md",
      type: "file",
    });
  });

  it("디렉토리 항목의 type이 directory이다", () => {
    const result = parseLs("ls", ["-la"], lsLaOutput) as { entries: Array<{ name: string; type: string }> };
    const src = result.entries.find(e => e.name === "src");
    expect(src?.type).toBe("directory");
  });

  it("maxItems=2이면 entries 2개 + _summary 반환", () => {
    const result = parseLs("ls", ["-la"], lsLaOutput, { maxItems: 2 }) as any;
    expect(result.entries).toHaveLength(2);
    expect(result._summary).toEqual({ total: 4, shown: 2, truncated: true });
  });

  it("maxItems=0이면 전체 반환 (_summary 없음)", () => {
    const result = parseLs("ls", ["-la"], lsLaOutput, { maxItems: 0 }) as any;
    expect(result.entries).toHaveLength(4);
    expect(result._summary).toBeUndefined();
  });
});

describe("parseFind()", () => {
  it("경로 목록을 파싱한다", () => {
    const raw    = "/home/user/src/index.ts\n/home/user/src/server.ts\n";
    const result = parseFind("find", ["."], raw) as { paths: string[] };
    expect(result.paths).toHaveLength(2);
    expect(result.paths[0]).toBe("/home/user/src/index.ts");
  });
});

describe("parseDu()", () => {
  it("디스크 사용량을 파싱한다", () => {
    const raw    = "4\t./src\n12\t.\n";
    const result = parseDu("du", ["-sh"], raw) as { entries: Array<{ size: string; path: string }> };
    expect(result.entries[0]).toEqual({ size: "4", path: "./src" });
  });
});

describe("parseDf()", () => {
  it("파일시스템 사용량을 파싱한다", () => {
    const raw = [
      "Filesystem     1K-blocks    Used Available Use% Mounted on",
      "/dev/sda1       51475068 8234456  40626092  17% /",
    ].join("\n");
    const result = parseDf("df", ["-h"], raw) as { filesystems: Array<{ filesystem: string; mounted_on: string }> };
    expect(result.filesystems[0].filesystem).toBe("/dev/sda1");
    expect(result.filesystems[0].mounted_on).toBe("/");
  });
});
