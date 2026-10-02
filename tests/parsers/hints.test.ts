import { describe, it, expect } from "vitest";
import { createRegistry }       from "../../src/parsers/index.js";
import { BUILTIN_CONTRACTS }    from "../../src/parsers/contracts.js";
import { checkGuard }           from "../../src/engine/guard.js";
import { DEFAULT_CONFIG }       from "../../src/config/loader.js";
import type { PrismConfig }     from "../../src/config/loader.js";
import type { ParserContract }  from "../../src/parsers/registry.js";

const reg = createRegistry();

/** 형식 밖의 인자로 parse해 얻은 안내 */
const hintFor = (cmd: string, args: string[]) => reg.parse(cmd, args, "").parse_error?.hint;

/**
 * 안내가 있는 경우: [명령, 원래 인자, 안내 인자, 안내 인자로 실행했을 때의 출력].
 * 출력은 손으로 쓴 몇 줄이며 외부 도구를 실행하지 않는다.
 */
const CASES: Array<[string, string[], string[], string]> = [
  ["ls", ["-lh"], ["-l"], "total 4\n-rw-r--r-- 1 u g 12 Oct  3 06:45 a.txt\n"],
  ["ls", ["-a"], ["-a", "-l"], "total 4\ndrwxr-xr-x 2 u g 4096 Oct  3 06:45 .\n"],
  ["ls", ["-lF", "dir"], ["-l", "dir"], "total 4\n-rwxr-xr-x 1 u g 12 Oct  3 06:45 run.sh\n"],
  ["find", [".", "-print0"], ["."], ".\n./a.txt\n"],
  ["du", ["-0", "-s", "dir"], ["-s", "dir"], "8\tdir\n"],
  ["df", ["-m"], [], "Filesystem 1K-blocks Used Available Use% Mounted on\n/dev/sda1 100 40 60 40% /\n"],
  ["ps", ["auxf"], ["aux"], "USER PID %CPU %MEM VSZ RSS TTY STAT START TIME COMMAND\nroot 1 0.0 0.1 1000 200 ? Ss 10:00 0:01 /sbin/init\n"],
  ["ps", ["aux", "--no-headers"], ["aux"], "USER PID %CPU %MEM VSZ RSS TTY STAT START TIME COMMAND\nroot 1 0.0 0.1 1000 200 ? Ss 10:00 0:01 /sbin/init\n"],
  ["dig", ["+short", "example.com"], ["example.com"],
    ";; QUESTION SECTION:\n;example.com. IN A\n\n;; ANSWER SECTION:\nexample.com. 300 IN A 93.184.215.14\n"],
  ["grep", ["-Z", "x", "a", "b"], ["x", "a", "b"], "a:hit\nb:hit\n"],
  ["grep", ["-A1", "x", "f"], ["-n", "-A1", "x", "f"], "7:hit\n8-next\n"],
  ["env", ["-0"], [], "HOME=/home/u\n"],
  ["free", ["-h"], ["-b"], "               total        used        free      shared  buff/cache   available\nMem:      1024 512 512 0 0 512\n"],
  ["uname", ["-r"], ["-a"], "Linux host 6.8.0-1-generic #1 SMP x86_64 x86_64 x86_64 GNU/Linux\n"],
  ["id", ["-un"], [], "uid=1000(u) gid=1000(u) groups=1000(u)\n"],
  ["journalctl", ["-o", "json", "-n", "5"], ["-n", "5", "-o", "short-iso"], "2026-10-03T06:00:00+0900 host cron[12]: started\n"],
  ["git", ["status", "-s"], ["status"], "On branch main\nChanges not staged for commit:\n\tmodified:   a.txt\n"],
  ["git", ["--no-pager", "status", "--porcelain"], ["--no-pager", "status"], "On branch main\nnothing to commit, working tree clean\n"],
  ["git", ["log", "--oneline", "--graph"], ["log", "--format=%h %s"], "abc1234 first\n"],
  ["git", ["log", "-n", "3"], ["log", "-n", "3", "--format=%h %s"], "abc1234 first\n"],
  ["git", ["branch"], ["branch", "-v"], "* main abc1234 first\n"],
  ["docker", ["ps", "-q"], ["ps"], "CONTAINER ID   IMAGE   COMMAND   CREATED   STATUS   PORTS   NAMES\nabc123   nginx   \"nginx\"   1 day ago   Up 1 day   80/tcp   web\n"],
  ["docker", ["ps", "--format", "json", "-a"], ["ps", "-a"], "CONTAINER ID   IMAGE   COMMAND   CREATED   STATUS   PORTS   NAMES\nabc123   nginx   \"nginx\"   1 day ago   Up 1 day   80/tcp   web\n"],
  ["kubectl", ["get", "pods", "-o", "yaml"], ["get", "pods", "-o", "json"], "{\"items\":[]}\n"],
  ["kubectl", ["get", "nodes"], ["get", "nodes", "-o", "json"], "{\"items\":[]}\n"],
  ["gh", ["issue", "list"], ["issue", "list", "--json", "number,title,state,author,labels,updatedAt"], "[{\"number\":1,\"title\":\"t\"}]\n"],
  ["gh", ["repo", "view"], ["repo", "view", "--json", "name,owner,description,url,defaultBranchRef"], "{\"name\":\"r\"}\n"],
  ["gh", ["run", "list", "-L", "3"], ["run", "list", "-L", "3", "--json", "databaseId,name,status,conclusion,headBranch,createdAt"], "[]\n"],
  ["gh", ["release", "list"], ["release", "list", "--json", "tagName,name,isLatest,publishedAt"], "[]\n"],
  ["npm", ["ls", "--parseable"], ["ls", "--json"], "{\"name\":\"p\",\"dependencies\":{}}\n"],
  ["npm", ["outdated"], ["outdated", "--json"], "{}\n"],
];

const POLICY_CONFIG: PrismConfig = { ...DEFAULT_CONFIG, guard: { ...DEFAULT_CONFIG.guard, allowed_paths: [], profile: "readonly" } };

describe("failure.hint 안내 인자", () => {
  it.each(CASES)("%s %j 는 %j 를 안내한다", (cmd, args, expected) => {
    const hint = hintFor(cmd, args);
    expect(hint?.args).toEqual(expected);
    expect(hint?.reason).toMatch(/\S/);
  });

  it.each(CASES)("%s %j 의 안내 인자는 readonly 기본 정책을 통과한다", (cmd, _args, expected) => {
    expect(() => checkGuard(cmd, expected, process.cwd(), POLICY_CONFIG)).not.toThrow();
  });

  it.each(CASES)("%s %j 를 안내 인자로 다시 실행하면 parsed가 null이 아니다", (cmd, _args, expected, raw) => {
    const r = reg.parseWithFallback(cmd, expected, raw, { maxItems: 0, format: "json" });
    expect(r.parse_error).toBeUndefined();
    expect(r.parsed).not.toBeNull();
  });

  it("안내 함수가 있는 내장 계약은 모두 시험 사례가 있다", () => {
    const hinted = (c: ParserContract): boolean => c.hint !== undefined || Object.values(c.subcommands ?? {}).some(hinted);
    const withHints = Object.entries(BUILTIN_CONTRACTS).filter(([, c]) => hinted(c)).map(([cmd]) => cmd).sort();
    const covered   = [...new Set(CASES.map(([cmd]) => cmd))].sort();
    expect(covered).toEqual(withHints);
  });

  it("같은 정보를 얻을 수 있는 인자가 없으면 안내하지 않는다", () => {
    for (const [cmd, args] of [
      ["ls", ["-lR"]], ["git", ["diff", "--stat"]], ["git", ["log", "-p"]], ["grep", ["-z", "x", "f"]],
      ["curl", ["-s", "https://example.com"]], ["ss", ["-s"]], ["apt", ["show", "bash"]], ["docker", ["stats", "--no-stream"]], ["stat", ["-c", "%s", "a"]],
    ] as Array<[string, string[]]>) {
      const r = reg.parse(cmd, args, "");
      expect(r.parse_error?.reason).toBe("unsupported_format");
      expect(r.parse_error?.hint).toBeUndefined();
    }
  });

  it("안내는 원래 인자와 다르다", () => {
    for (const [cmd, args] of CASES) expect(hintFor(cmd, args)?.args).not.toEqual(args);
  });
});

describe("parseWithFallback()", () => {
  it("native JSON 폴백이 성공하면 unsupported_format을 숨긴다", () => {
    const r = reg.parseWithFallback("npm", ["ls", "--json"], "{\"name\":\"p\"}\n");
    expect(r).toEqual({ parsed: { name: "p" }, native: true });
  });

  it("폴백이 실패하면 parse_error와 안내를 그대로 둔다", () => {
    const r = reg.parseWithFallback("uname", ["-r"], "6.8.0\n");
    expect(r.parsed).toBeNull();
    expect(r.native).toBe(false);
    expect(r.parse_error).toMatchObject({ reason: "unsupported_format", hint: { args: ["-a"] } });
  });
});
