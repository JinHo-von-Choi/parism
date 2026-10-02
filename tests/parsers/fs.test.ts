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

describe("parseLs() 특수 표기", () => {
  it("setuid, sticky, 장치, ACL, 심볼릭 링크 표기를 인식한다", () => {
    const raw = [
      "-rwsr-xr-x 1 root root 55680 Mar 23  2024 sudo",
      "drwxrwxrwt 20 root root 4096 Oct  3 01:00 tmp",
      "crw-rw-rw- 1 root root 1, 3 Oct  3 01:00 null",
      "-rw-r--r--+ 1 a a 10 Oct  3 01:00 acl.txt",
      "lrwxrwxrwx 1 a a 4 Oct  3 01:00 link -> dest",
    ].join("\n");
    const { entries } = parseLs("ls", ["-l"], raw) as { entries: { name: string; type: string; target?: string }[] };
    expect(entries.map(e => e.name)).toEqual(["sudo", "tmp", "null", "acl.txt", "link"]);
    expect(entries[2]!.type).toBe("char_device");
    expect(entries[4]!).toMatchObject({ name: "link", target: "dest" });
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

  it("심볼릭 링크는 이름과 대상을 나눠 담는다", () => {
    const raw = statLinuxRaw.replace("File: /home/user/project/src/index.ts", "File: link-to-a -> a.txt");
    expect(parseStat("stat", [], raw)).toMatchObject({ file: "link-to-a", link_target: "a.txt", size_bytes: 4096 });
  });

  it("파일 여러 개는 files 배열로 구간마다 담는다", () => {
    const second = statLinuxRaw.replace("/home/user/project/src/index.ts", "/tmp/b").replace("Size: 4096", "Size: 7");
    const result = parseStat("stat", [], `${statLinuxRaw}\n${second}\n`) as { files: Array<{ file: string; size_bytes: number }> };
    expect(result.files.map(f => [f.file, f.size_bytes])).toEqual([["/home/user/project/src/index.ts", 4096], ["/tmp/b", 7]]);
  });

  it("한 구간이라도 읽지 못하면 { lines } 폴백", () => {
    const result = parseStat("stat", [], `${statLinuxRaw}\n  File: /tmp/broken\n`) as { lines: string[] };
    expect(Array.isArray(result.lines)).toBe(true);
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
  type Rows = { filesystems: Array<{ filesystem: string; type?: string; blocks_1k?: string; size?: string; used: string; available: string; use_percent: string; mounted_on: string }>; block_size?: string };

  it("1M 블록 열은 blocks_1k가 아니라 size에 담고 block_size를 남긴다", () => {
    const raw = ["Filesystem 1M-blocks Used Available Use% Mounted on", "tmpfs 12876 46 12830 1% /run"].join("\n");
    const r = parseDf("df", ["-m"], raw) as Rows;
    expect(r.block_size).toBe("1M");
    expect(r.filesystems[0]).toEqual({ filesystem: "tmpfs", size: "12876", used: "46", available: "12830", use_percent: "1%", mounted_on: "/run" });
  });

  it("1K 블록과 단위 붙은 크기는 blocks_1k에 담고 block_size를 두지 않는다", () => {
    const k = parseDf("df", [], "Filesystem 1K-blocks Used Available Use% Mounted on\n/dev/sda1 100 40 60 40% /\n") as Rows;
    expect(k.block_size).toBeUndefined();
    expect(k.filesystems[0]!.blocks_1k).toBe("100");
    const h = parseDf("df", ["-h"], "Filesystem Size Used Avail Use% Mounted on\nefivarfs 181k 90k 86k 51% /sys/firmware/efi/efivars\n") as Rows;
    expect(h.filesystems[0]).toMatchObject({ blocks_1k: "181k", used: "90k", available: "86k", mounted_on: "/sys/firmware/efi/efivars" });
  });

  it("마운트 위치와 파일 시스템 이름의 공백을 지킨다", () => {
    const raw = ["Filesystem 1K-blocks Used Available Use% Mounted on", "/dev/sdb1 100 40 60 40% /mnt/My Drive", "My Share 200 50 150 25% /srv/share one"].join("\n");
    const r = parseDf("df", [], raw) as Rows;
    expect(r.filesystems.map(f => [f.filesystem, f.mounted_on])).toEqual([["/dev/sdb1", "/mnt/My Drive"], ["My Share", "/srv/share one"]]);
  });

  it("-T는 type 열을 읽는다", () => {
    const raw = ["Filesystem Type 1K-blocks Used Available Use% Mounted on", "/dev/sda1 ext4 100 40 60 40% /"].join("\n");
    expect((parseDf("df", ["-T"], raw) as Rows).filesystems[0]).toMatchObject({ filesystem: "/dev/sda1", type: "ext4", blocks_1k: "100", mounted_on: "/" });
  });

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
