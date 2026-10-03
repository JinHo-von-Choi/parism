/**
 * 플랫폼별 실제 명령 출력 검사.
 * 현재 OS에서 쓸 수 있는 명령을 시험 시점에 실행해 출력을 받고, 레지스트리로 파싱한 결과에
 * 파서 불변식(src/parsers/invariants.ts)과 기본 필드 검사를 적용한다. 출력은 저장하지 않는다.
 * 다른 OS의 명령과 이 환경에 없거나 실행에 실패한 명령은 건너뛴다.
 * 자식 프로세스 환경은 실행기와 같이 LC_ALL=C, LANG=C다.
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFile }                               from "node:child_process";
import { createServer, type Server }              from "node:http";
import type { AddressInfo }                       from "node:net";
import path                                       from "node:path";
import { fileURLToPath }                          from "node:url";
import { promisify }                              from "node:util";
import { createRegistry }                         from "../../src/parsers/index.js";
import { checkInvariants }                        from "../../src/parsers/invariants.js";

const execFileAsync = promisify(execFile);

const REPO_ROOT          = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const DEFAULT_TIMEOUT_MS = 15_000;

type Platform = "linux" | "darwin" | "win32";
type Row      = Record<string, unknown>;

const UNIX: Platform[] = ["linux", "darwin"];
const ALL:  Platform[] = ["linux", "darwin", "win32"];

/**
 * 검사할 명령.
 * cmd/args  -- 레지스트리가 보는 명령과 인자
 * exec      -- 실제로 실행할 파일과 인자. 없으면 cmd와 args다(cmd 내장 명령 dir은 cmd /d /c로 실행).
 * check     -- 파싱 결과의 기본 필드 검사
 */
interface PlatformCase {
  platforms:  Platform[];
  cmd:        string;
  args:       (ctx: CaseContext) => string[];
  exec?:      (ctx: CaseContext) => { file: string; args: string[] };
  timeoutMs?: number;
  check:      (parsed: Row, ctx: CaseContext) => void;
}

interface CaseContext {
  root:    string;
  httpUrl: string;
  pid:     string;
}

/** 결과의 배열 필드. 배열이 아니면 시험을 실패시킨다. */
function rows(parsed: Row, key: string): Row[] {
  const value = parsed[key];
  expect(Array.isArray(value), `${key} is an array`).toBe(true);
  return value as Row[];
}

function isPositiveInt(value: unknown): boolean {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

const pkg = (ctx: CaseContext): string => path.join(ctx.root, "package.json");

const CASES: PlatformCase[] = [
  {
    platforms: UNIX, cmd: "ls", args: ctx => ["-l", ctx.root],
    check: p => expect(rows(p, "entries").some(e => e.name === "package.json")).toBe(true),
  },
  {
    platforms: UNIX, cmd: "ls", args: ctx => ["-la", path.join(ctx.root, "src")],
    check: p => expect(rows(p, "entries").some(e => e.name === "index.ts")).toBe(true),
  },
  {
    platforms: UNIX, cmd: "ps", args: () => ["aux"],
    check: p => {
      const procs = rows(p, "processes");
      expect(procs.length).toBeGreaterThan(0);
      expect(procs.every(r => isPositiveInt(r.pid) || r.pid === 0)).toBe(true);
      expect(procs.some(r => r.pid === process.pid)).toBe(true);
    },
  },
  {
    platforms: UNIX, cmd: "df", args: () => ["-k"],
    check: p => {
      const fs = rows(p, "filesystems");
      expect(fs.length).toBeGreaterThan(0);
      expect(fs.every(r => typeof r.mounted_on === "string" && r.mounted_on.startsWith("/"))).toBe(true);
    },
  },
  {
    platforms: UNIX, cmd: "du", args: ctx => ["-s", path.join(ctx.root, "src")],
    check: p => {
      const entries = rows(p, "entries");
      expect(entries).toHaveLength(1);
      expect(String(entries[0]?.path)).toMatch(/src$/);
    },
  },
  {
    platforms: UNIX, cmd: "stat", args: ctx => [pkg(ctx)],
    check: p => expect(Number(p.size_bytes)).toBeGreaterThan(0),
  },
  {
    platforms: UNIX, cmd: "find", args: ctx => [path.join(ctx.root, "src", "parsers", "fs"), "-name", "*.ts"],
    check: p => expect(rows(p, "paths").some(f => String(f).endsWith("ls.ts"))).toBe(true),
  },
  {
    platforms: UNIX, cmd: "uname", args: () => ["-a"],
    check: p => expect(String(p.kernel_name)).toMatch(process.platform === "darwin" ? /Darwin/ : /Linux/),
  },
  {
    platforms: UNIX, cmd: "id", args: () => [],
    check: p => expect(typeof p.uid === "number" && p.uid >= 0).toBe(true),
  },
  {
    platforms: UNIX, cmd: "ping", args: () => ["-c", "1", "127.0.0.1"],
    check: p => expect(p.packets_transmitted).toBe(1),
  },
  {
    platforms: ALL, cmd: "curl", args: ctx => ["-s", "-I", ctx.httpUrl],
    check: p => expect(JSON.stringify(p)).toContain("200"),
  },
  {
    platforms: ["linux"], cmd: "netstat", args: () => ["-tan"],
    check: p => { rows(p, "connections"); },
  },
  {
    platforms: ["darwin"], cmd: "netstat", args: () => ["-an"],
    check: p => { rows(p, "connections"); },
  },
  {
    platforms: ["linux"], cmd: "ss", args: () => ["-tan"],
    check: p => { rows(p, "connections"); },
  },
  {
    platforms: UNIX, cmd: "lsof", args: ctx => ["-n", "-P", "-p", ctx.pid],
    check: p => expect(rows(p, "entries").some(e => e.pid === process.pid)).toBe(true),
  },
  {
    platforms: ["linux"], cmd: "free", args: () => ["-m"],
    check: p => expect(Number((p.mem as Row | undefined)?.total)).toBeGreaterThan(0),
  },
  {
    platforms: ["linux"], cmd: "systemctl", args: () => ["--no-pager", "list-units"],
    check: p => expect(rows(p, "units").length).toBeGreaterThan(0),
  },
  {
    platforms: UNIX, cmd: "wc", args: ctx => ["-l", pkg(ctx)],
    check: p => expect(Number(rows(p, "entries")[0]?.count)).toBeGreaterThan(0),
  },
  {
    platforms: UNIX, cmd: "grep", args: ctx => ["-n", "parism", pkg(ctx)],
    check: p => expect(rows(p, "matches").length).toBeGreaterThan(0),
  },
  {
    platforms: UNIX, cmd: "which", args: () => ["node"],
    check: p => expect(rows(p, "paths").length).toBeGreaterThan(0),
  },
  {
    platforms: ALL, cmd: "git", args: ctx => ["-C", ctx.root, "status"],
    check: p => expect(typeof p.branch === "string" || p.branch === null).toBe(true),
  },
  {
    platforms: ALL, cmd: "git", args: ctx => ["-C", ctx.root, "log", "-n", "3", "--oneline"],
    check: p => {
      const commits = rows(p, "commits");
      expect(commits.length).toBeGreaterThan(0);
      expect(commits.every(c => /^[0-9a-f]{7,}$/.test(String(c.hash)))).toBe(true);
    },
  },
  {
    platforms: ["win32"], cmd: "dir", args: ctx => [ctx.root],
    exec:  ctx => ({ file: "cmd", args: ["/d", "/c", "dir", ctx.root] }),
    check: p => {
      const file = rows(p, "entries").find(e => e.name === "package.json");
      expect(file?.type).toBe("file");
      expect(Number(file?.size_bytes)).toBeGreaterThan(0);
      expect(rows(p, "entries").some(e => e.name === "src" && e.type === "directory")).toBe(true);
    },
  },
  {
    platforms: ["win32"], cmd: "dir", args: ctx => ["/b", ctx.root],
    exec:  ctx => ({ file: "cmd", args: ["/d", "/c", "dir", "/b", ctx.root] }),
    check: p => expect(rows(p, "entries").some(e => e.name === "package.json")).toBe(true),
  },
  {
    platforms: ["win32"], cmd: "tasklist", args: () => [],
    check: p => {
      const procs = rows(p, "processes");
      expect(procs.some(r => /^node(\.exe)?$/i.test(String(r.name)) && isPositiveInt(r.pid))).toBe(true);
    },
  },
  {
    platforms: ["win32"], cmd: "tasklist", args: () => ["/fo", "csv"],
    check: p => expect(rows(p, "processes").some(r => r.pid === process.pid)).toBe(true),
  },
  {
    platforms: ["win32"], cmd: "ipconfig", args: () => [],
    check: p => expect(rows(p, "adapters").length).toBeGreaterThan(0),
  },
  {
    platforms: ["win32"], cmd: "ipconfig", args: () => ["/all"],
    check: p => {
      expect(typeof p.hostname).toBe("string");
      expect(rows(p, "adapters").length).toBeGreaterThan(0);
    },
  },
  {
    platforms: ["win32"], cmd: "systeminfo", args: () => [], timeoutMs: 120_000,
    check: p => {
      expect(String(p.os_name)).toMatch(/Windows/);
      expect(Number(p.total_memory_mb)).toBeGreaterThan(0);
    },
  },
];

type Capture = { ok: true; stdout: string } | { ok: false; reason: string };

/** 명령을 실행해 stdout을 받는다. 없거나 실패하면 건너뛸 이유를 돌려준다. */
async function capture(file: string, args: string[], timeoutMs: number): Promise<Capture> {
  try {
    const { stdout } = await execFileAsync(file, args, {
      timeout:     timeoutMs,
      maxBuffer:   32 * 1024 * 1024,
      windowsHide: true,
      env:         { ...process.env, LC_ALL: "C", LANG: "C" },
    });
    return { ok: true, stdout };
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { killed?: boolean; code?: string | number };
    if (e.code === "ENOENT") return { ok: false, reason: `${file} is not installed` };
    if (e.killed)            return { ok: false, reason: `${file} did not finish within ${timeoutMs} ms` };
    return { ok: false, reason: `${file} exited with ${String(e.code)}` };
  }
}

const registry = createRegistry();
const context: CaseContext = { root: REPO_ROOT, httpUrl: "", pid: String(process.pid) };
let   server: Server | undefined;
/** 건너뛰지 않고 출력을 받아 검사까지 간 사례 수 */
let   executed = 0;

beforeAll(async () => {
  server = createServer((_req, res) => res.writeHead(200, { "content-type": "text/plain" }).end("ok"));
  await new Promise<void>(resolve => server!.listen(0, "127.0.0.1", resolve));
  context.httpUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
});

afterAll(async () => {
  await new Promise<void>(resolve => server ? server.close(() => resolve()) : resolve());
});

describe(`실제 명령 출력 불변식 (${process.platform})`, () => {
  for (const c of CASES) {
    const label     = [c.cmd, ...c.args({ root: "<repo>", httpUrl: "<url>", pid: "<pid>" })].join(" ");
    const timeoutMs = c.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const enabled   = (c.platforms as string[]).includes(process.platform);

    it.runIf(enabled)(label, async (t) => {
      const args = c.args(context);
      const run  = c.exec?.(context) ?? { file: c.cmd, args };
      const out  = await capture(run.file, run.args, timeoutMs);
      if (!out.ok) t.skip(out.reason);
      executed++;

      const result = registry.parse(c.cmd, args, out.stdout, { maxItems: 0, format: "json" });
      expect(result.parse_error, JSON.stringify(result.parse_error)).toBeUndefined();
      expect(result.parsed).not.toBeNull();

      const violations = checkInvariants(result.parsed, out.stdout, registry.contractFor(c.cmd, args));
      expect(violations).toEqual([]);
      c.check(result.parsed as Row, context);
    }, timeoutMs + 5_000);
  }

  /** CI에서는 모든 사례가 건너뛰어진 채 통과하지 않도록 이 OS에서 실제로 실행한 사례가 있어야 한다. */
  it.runIf(Boolean(process.env.CI))("이 OS에서 실제로 실행한 사례가 하나 이상이다", () => {
    expect(executed).toBeGreaterThan(0);
  });
});
