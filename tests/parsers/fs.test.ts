import { describe, it, expect } from "vitest";
import { parseLs }   from "../../src/parsers/fs/ls.js";
import { parseFind } from "../../src/parsers/fs/find.js";
import { parseStat } from "../../src/parsers/fs/stat.js";
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
    const result = parseLs("ls", ["-la"], lsLaOutput, { maxItems: 2 }) as { entries: unknown[]; _summary?: { total: number; shown: number; truncated: boolean } };
    expect(result.entries).toHaveLength(2);
    expect(result._summary).toEqual({ total: 4, shown: 2, truncated: true });
  });

  it("maxItems=0이면 전체 반환 (_summary 없음)", () => {
    const result = parseLs("ls", ["-la"], lsLaOutput, { maxItems: 0 }) as { entries: unknown[]; _summary?: unknown };
    expect(result.entries).toHaveLength(4);
    expect(result._summary).toBeUndefined();
  });
});

describe("parseStat()", () => {
  const statLinuxRaw = [
    "  File: /home/user/project/src/index.ts",
    "  Size: 4096            Blocks: 8          IO Block: 4096   regular file",
    "Device: fd01h/64769d    Inode: 2097153      Links: 1",
    "Access: (0644/-rw-r--r--)  Uid: ( 1000/    user)   Gid: ( 1000/    user)",
    "Access: 2026-03-06 09:15:23.123456789 +0000",
    "Modify: 2026-03-06 09:00:42.987654321 +0000",
    "Change: 2026-03-06 09:00:42.987654321 +0000",
    " Birth: 2026-03-01 14:22:00.000000000 +0000",
  ].join("\n");

  const statMacosRaw =
    '16777220 2097153 -rw-r--r-- 1 user staff 0 4096 "Mar  6 09:00:42 2026" "Mar  6 09:15:23 2026" "Mar  6 09:00:42 2026" "Mar  1 14:22:00 2026" 4096 8 0x0 /home/user/project/src/index.ts';

  it("형식 불일치 시 { lines } 폴백", () => {
    const result = parseStat("stat", [], "not a stat output") as { lines: string[] };
    expect(result.lines).toEqual(["not a stat output"]);
  });

  it("Linux 형식 stat 출력을 파싱한다", () => {
    const result = parseStat("stat", [], statLinuxRaw) as { file: string; size_bytes: number; permissions: string };
    expect(result.file).toBe("/home/user/project/src/index.ts");
    expect(result.size_bytes).toBe(4096);
    expect(result.permissions).toBe("-rw-r--r--");
  });

  it("macOS 형식 stat 출력을 파싱한다", () => {
    const result = parseStat("stat", [], statMacosRaw) as { file: string; size_bytes: number; permissions: string };
    expect(result.file).toBe("/home/user/project/src/index.ts");
    expect(result.size_bytes).toBe(4096);
    expect(result.permissions).toBe("-rw-r--r--");
  });

  it("File/Size만 있고 나머지 필드 없으면 0/빈 문자열", () => {
    const minimal = "  File: /tmp/x\n  Size: 1024";
    const result = parseStat("stat", [], minimal) as { file: string; size_bytes: number; blocks: number; io_block: number };
    expect(result.file).toBe("/tmp/x");
    expect(result.size_bytes).toBe(1024);
    expect(result.blocks).toBe(0);
    expect(result.io_block).toBe(0);
  });
});

describe("parseFind()", () => {
  it("maxItems 초과 시 _summary와 truncation", () => {
    const raw    = Array.from({ length: 10 }, (_, i) => `/path/file${i}.ts`).join("\n");
    const result = parseFind("find", ["."], raw, { maxItems: 3, format: "json" }) as {
      paths: unknown[];
      _summary: { total: number; shown: number; truncated: boolean };
    };
    expect(result.paths).toHaveLength(3);
    expect(result._summary.total).toBe(10);
    expect(result._summary.truncated).toBe(true);
  });

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
  it("6컬럼 미만 행은 스킵", () => {
    const raw = [
      "Filesystem     1K-blocks    Used Available Use% Mounted on",
      "/dev/sda1      1024000  500000    524000  49% /",
      "short",
    ].join("\n");
    const result = parseDf("df", ["-h"], raw) as { filesystems: Array<{ filesystem: string }> };
    expect(result.filesystems).toHaveLength(1);
  });
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
