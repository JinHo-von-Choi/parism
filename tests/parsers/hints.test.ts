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

/** 안내 인자(git diff 패치)로 실행했을 때의 출력 */
const GIT_DIFF_SAMPLE = [
  "diff --git a/c.txt b/c.txt",
  "new file mode 100644",
  "index 0000000..f2ad6c7",
  "--- /dev/null",
  "+++ b/c.txt",
  "@@ -0,0 +1 @@",
  "+c",
  "diff --git a/e.txt b/e.txt",
  "index 1111111..2222222 100644",
  "--- a/e.txt",
  "+++ b/e.txt",
  "@@ -1,2 +1,2 @@",
  " keep",
  "-old",
  "+new",
].join("\n") + "\n";

/** 안내 인자(systemctl list-units --all <유닛>)로 실행했을 때의 출력 */
const SYSTEMCTL_SAMPLE = [
  "  UNIT         LOAD   ACTIVE SUB     DESCRIPTION",
  "  cron.service loaded active running Regular background program processing daemon",
  "",
  "Legend: LOAD   -> Reflects whether the unit definition was properly loaded.",
  "",
  "1 loaded units listed.",
].join("\n") + "\n";

/** 안내 인자(ps aux)로 실행했을 때의 출력 */
const PS_SAMPLE = [
  "USER         PID %CPU %MEM    VSZ   RSS TTY      STAT START   TIME COMMAND",
  "root           1  0.0  0.1 168000 12000 ?        Ss   Oct02   0:05 /sbin/init splash",
  "nirna      42000  1.5  0.2  20000  3000 pts/0    R+   09:30   0:00 ps aux",
].join("\n") + "\n";

/**
 * 안내가 있는 경우: [명령, 원래 인자, 안내 인자, 안내 인자로 실행했을 때의 출력].
 * 출력은 손으로 쓴 몇 줄이며 외부 도구를 실행하지 않는다.
 */
const CASES: Array<[string, string[], string[], string]> = [
  ["ls", ["-lh"], ["-l"], "total 4\n-rw-r--r-- 1 u g 12 Oct  3 06:45 a.txt\n"],
  ["ls", ["-a"], ["-a", "-l"], "total 4\ndrwxr-xr-x 2 u g 4096 Oct  3 06:45 .\n"],
  ["ls", ["-lG", "dir"], ["-l", "dir"], "total 4\n-rwxr-xr-x 1 u g 12 Oct  3 06:45 run.sh\n"],
  ["df", ["-BG"], [], "Filesystem 1K-blocks Used Available Use% Mounted on\n/dev/sda1 100 40 60 40% /\n"],
  ["dig", ["+short", "example.com"], ["example.com"],
    ";; QUESTION SECTION:\n;example.com. IN A\n\n;; ANSWER SECTION:\nexample.com. 300 IN A 93.184.215.14\n"],
  ["grep", ["-Z", "x", "a", "b"], ["x", "a", "b"], "a:hit\nb:hit\n"],
  ["grep", ["-A1", "x", "f"], ["-n", "-A1", "x", "f"], "7:hit\n8-next\n"],
  ["free", ["--tera"], ["-b"], "               total        used        free      shared  buff/cache   available\nMem:      1024 512 512 0 0 512\n"],
  ["uname", ["-r"], ["-a"], "Linux host 6.8.0-1-generic #1 SMP x86_64 x86_64 x86_64 GNU/Linux\n"],
  ["id", ["-un"], [], "uid=1000(u) gid=1000(u) groups=1000(u)\n"],
  ["journalctl", ["-o", "json", "-n", "5"], ["-n", "5", "-o", "short-iso"], "2026-10-03T06:00:00+0900 host cron[12]: started\n"],
  ["git", ["status", "-s"], ["status"], "On branch main\nChanges not staged for commit:\n\tmodified:   a.txt\n"],
  /** porcelain 과 -z 는 이제 기본 지원 형식이므로 힌트 대상에서 빠졌다(입력 표에도 둘 이유가 없다). */
  ["git", ["--no-pager", "status", "--column"], ["--no-pager", "status"], "On branch main\nnothing to commit, working tree clean\n"],
  ["git", ["log", "--oneline", "--graph"], ["log", "--format=%h %s"], "abc1234 first\n"],
  ["git", ["status", "--short", "--ignored"], ["status", "--ignored"], "On branch main\nIgnored files:\n  (use \"git add -f <file>...\" to include in what will be committed)\n\tbuild/\n"],
  ["git", ["status", "-s", "--ignored=matching"], ["status", "--ignored=matching"], "On branch main\nIgnored files:\n\tbuild/a.o\n"],
  ["git", ["log", "-n", "3"], ["log", "-n", "3", "--format=%h%x09%an%x09%aI%x09%s"], "abc1234\tAlice Kim\t2026-10-03T06:00:00+09:00\tfirst\n"],
  ["git", ["log", "--format=%h_%an_%s"], ["log", "--format=%h%x09%an%x09%aI%x09%s"], "abc1234\tAlice Kim\t2026-10-03T06:00:00+09:00\tfirst\n"],
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
  ["git", ["diff", "--stat", "HEAD~2"], ["diff", "HEAD~2"], GIT_DIFF_SAMPLE],
  ["git", ["diff", "--name-only"], ["diff"], GIT_DIFF_SAMPLE],
  ["git", ["diff", "--name-status", "--cached"], ["diff", "--cached"], GIT_DIFF_SAMPLE],
  ["git", ["diff", "--numstat", "HEAD~1", "--", "c.txt"], ["diff", "HEAD~1", "--", "c.txt"], GIT_DIFF_SAMPLE],
  ["git", ["branch", "--show-current"], ["branch", "-v"], "  feature 3a7ab88 plain third\n* main    7434367 fourth\n"],
  ["systemctl", ["status", "cron"], ["list-units", "--all", "cron.service"], SYSTEMCTL_SAMPLE],
  ["systemctl", ["is-active", "cron", "ssh.socket"], ["list-units", "--all", "cron.service", "ssh.socket"], SYSTEMCTL_SAMPLE],
  ["systemctl", ["is-failed", "app", "--user"], ["list-units", "--all", "app.service", "--user"], SYSTEMCTL_SAMPLE],
  ["systemctl", ["status", "--no-pager", "-l", "ssh*"], ["list-units", "--all", "ssh*", "--no-pager"], SYSTEMCTL_SAMPLE],
  ["ps", ["-e"], ["aux"], PS_SAMPLE],
  ["ps", ["-A", "--no-headers"], ["aux", "--no-headers"], PS_SAMPLE.split("\n").slice(1).join("\n")],
  ["ps", ["-eo", "pid,user,%cpu,args", "--sort=-%cpu"], ["aux", "--sort=-%cpu"], PS_SAMPLE],
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
      ["ls", ["-li"]], ["git", ["diff", "--word-diff"]], ["git", ["log", "-p"]], ["grep", ["-z", "x", "f"]],
      ["ps", ["-ef"]], ["ps", ["-eo", "pid,ppid,comm"]], ["systemctl", ["is-enabled", "cron"]], ["systemctl", ["status"]], ["systemctl", ["status", "1234"]],
      ["systemctl", ["list-unit-files"]],
      ["curl", ["-s", "https://example.com"]], ["ss", ["-s"]], ["apt", ["show", "bash"]], ["docker", ["images"]], ["stat", ["-c", "%s", "a"]],
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

describe("안내 인자로 다시 파싱한 값", () => {
  const parsed = (cmd: string, args: string[], raw: string): Record<string, unknown> => {
    const r = reg.parse(cmd, hintFor(cmd, args)!.args, raw);
    expect(r.parse_error).toBeUndefined();
    return r.parsed as Record<string, unknown>;
  };

  it("git diff --stat 계열은 패치로 경로, 변경 종류, 바뀐 줄을 얻는다", () => {
    const r = parsed("git", ["diff", "--numstat", "HEAD~2"], GIT_DIFF_SAMPLE) as { files_changed: string[]; files: Array<{ path: string; status: string; hunks: Array<{ lines: string[] }> }> };
    expect(r.files_changed).toEqual(["c.txt", "e.txt"]);
    expect(r.files.map(f => [f.path, f.status])).toEqual([["c.txt", "added"], ["e.txt", "modified"]]);
    expect(r.files[1]!.hunks[0]!.lines.filter(l => /^[+-]/.test(l))).toEqual(["-old", "+new"]);
  });

  it("git branch --show-current는 -v의 current 항목으로 현재 브랜치를 얻는다", () => {
    const r = parsed("git", ["branch", "--show-current"], "  feature 3a7ab88 plain third\n* main    7434367 fourth\n") as { branches: Array<{ name: string; current: boolean }> };
    expect(r.branches.filter(b => b.current).map(b => b.name)).toEqual(["main"]);
  });

  it("systemctl status, is-active는 list-units --all로 유닛 상태를 얻는다", () => {
    const r = parsed("systemctl", ["is-active", "cron"], SYSTEMCTL_SAMPLE) as { units: Array<Record<string, unknown>> };
    expect(r.units).toEqual([expect.objectContaining({ name: "cron.service", load: "loaded", active: "active", sub: "running" })]);
  });

  it("ps -e, -A, -eo(aux에 있는 열)는 aux로 같은 프로세스의 열을 얻는다", () => {
    const r = parsed("ps", ["-e"], PS_SAMPLE) as { processes: Array<Record<string, unknown>> };
    expect(r.processes.map(p => [p.user, p.pid, p.tty, p.time, p.command])).toEqual([["root", 1, "?", "0:05", "/sbin/init splash"], ["nirna", 42000, "pts/0", "0:00", "ps aux"]]);
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
