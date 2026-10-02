import { describe, it, expect } from "vitest";
import { checkFormat }          from "../../src/parsers/format.js";
import { ParserRegistry, type ParserContract } from "../../src/parsers/registry.js";
import { createRegistry }       from "../../src/parsers/index.js";

const accepts = (contract: ParserContract, args: string[]): boolean => checkFormat(contract, args).accepted;

describe("checkFormat() 플래그", () => {
  const contract: ParserContract = {
    acceptedFlags: { "-l": "bool", "-a": "bool", "-n": "value", "--sort": "value", "--color": "attached", "-U": "attached", "-<number>": "bool" },
    acceptedPositionals: { max: 1 },
  };

  it("선언이 없으면 모든 인자를 받는다", () => {
    expect(accepts({}, ["-xyz", "a", "b"])).toBe(true);
  });

  it("허용 플래그와 묶음 플래그를 받는다", () => {
    expect(accepts(contract, ["-l", "-a"])).toBe(true);
    expect(accepts(contract, ["-la"])).toBe(true);
  });

  it("목록 밖의 플래그는 그 이름과 함께 거부한다", () => {
    expect(checkFormat(contract, ["-lR"])).toMatchObject({ accepted: false, reason: expect.stringContaining("'-R'") });
    expect(checkFormat(contract, ["--recursive"])).toMatchObject({ accepted: false, reason: expect.stringContaining("'--recursive'") });
  });

  it("값을 받는 플래그는 다음 인자를 값으로 소비하고 위치 인자로 세지 않는다", () => {
    expect(accepts(contract, ["-n", "5", "dir"])).toBe(true);
    expect(accepts(contract, ["-n5", "dir"])).toBe(true);
    expect(accepts(contract, ["--sort", "size", "dir"])).toBe(true);
    expect(accepts(contract, ["--sort=size", "dir"])).toBe(true);
  });

  it("attached 플래그는 붙은 값만 받고 다음 인자를 소비하지 않는다", () => {
    expect(accepts(contract, ["--color=never", "dir"])).toBe(true);
    expect(accepts(contract, ["-U0", "dir"])).toBe(true);
    expect(accepts(contract, ["--color", "dir", "other"])).toBe(false);
  });

  it("값이 없는 플래그에 값을 붙이면 거부한다", () => {
    expect(accepts(contract, ["--sort=size", "-l"])).toBe(true);
    expect(accepts({ acceptedFlags: { "--all": "bool" } }, ["--all=yes"])).toBe(false);
  });

  it("숫자 축약 플래그는 -<number> 선언으로 받는다", () => {
    expect(accepts(contract, ["-5"])).toBe(true);
    expect(accepts({ acceptedFlags: {} }, ["-5"])).toBe(false);
  });

  it("-- 뒤는 모두 위치 인자다", () => {
    expect(accepts(contract, ["--", "-R"])).toBe(true);
    expect(accepts(contract, ["--", "a", "b"])).toBe(false);
  });
});

describe("checkFormat() 값, 필수, 배타, 위치 인자", () => {
  it("acceptedValues로 플래그 값을 제한한다", () => {
    const c: ParserContract = { acceptedFlags: { "-o": "value", "--output": "value" }, acceptedValues: { "-o": /^wide$/, "--output": /^wide$/ } };
    expect(accepts(c, ["-o", "wide"])).toBe(true);
    expect(accepts(c, ["-owide"])).toBe(true);
    expect(accepts(c, ["--output=wide"])).toBe(true);
    expect(checkFormat(c, ["-o", "json"])).toMatchObject({ accepted: false, reason: expect.stringContaining("json") });
  });

  it("requiredFlags 중 하나가 있어야 한다", () => {
    const c: ParserContract = { acceptedFlags: { "-l": "bool", "-a": "bool" }, requiredFlags: ["-l"] };
    expect(accepts(c, ["-la"])).toBe(true);
    expect(accepts(c, ["-a"])).toBe(false);
  });

  it("exclusiveFlags는 하나까지만 받는다", () => {
    const c: ParserContract = { acceptedFlags: { "-l": "bool", "-w": "bool" }, exclusiveFlags: ["-l", "-w"] };
    expect(accepts(c, ["-l"])).toBe(true);
    expect(accepts(c, ["-lw"])).toBe(false);
  });

  it("위치 인자 개수와 패턴을 검사한다", () => {
    const c: ParserContract = { acceptedFlags: {}, acceptedPositionals: { min: 1, max: 1, pattern: /^[ax]*u[ax]*$/ } };
    expect(accepts(c, ["aux"])).toBe(true);
    expect(accepts(c, [])).toBe(false);
    expect(accepts(c, ["auxf"])).toBe(false);
    expect(accepts(c, ["aux", "u"])).toBe(false);
  });

  it("plusFlags와 singleDashLong", () => {
    expect(accepts({ acceptedFlags: { "+tcp": "bool", "+D": "value" }, plusFlags: true }, ["+tcp", "+D", "dir", "host"])).toBe(true);
    expect(accepts({ acceptedFlags: { "+tcp": "bool" }, plusFlags: true }, ["+short", "host"])).toBe(false);
    const find: ParserContract = { acceptedFlags: { "-name": "value", "-type": "value", "-o": "bool" }, singleDashLong: true };
    expect(accepts(find, [".", "-name", "*.ts", "-o", "-type", "d"])).toBe(true);
    expect(accepts(find, [".", "-ls"])).toBe(false);
  });
});

describe("checkFormat() 서브커맨드와 supports", () => {
  const contract: ParserContract = {
    leadingFlags: { "--no-pager": "bool" },
    subcommands:  {
      log:    { acceptedFlags: { "--oneline": "bool" }, requiredFlags: ["--oneline"] },
      status: { acceptedFlags: {} },
    },
  };

  it("서브커맨드 계약으로 나머지 인자를 검사한다", () => {
    expect(accepts(contract, ["--no-pager", "log", "--oneline"])).toBe(true);
    expect(accepts(contract, ["log"])).toBe(false);
    expect(accepts(contract, ["status"])).toBe(true);
  });

  it("선언하지 않은 서브커맨드는 거부한다", () => {
    expect(checkFormat(contract, ["show"])).toMatchObject({ accepted: false, reason: expect.stringContaining("show") });
  });

  it("supports는 선언 검사를 통과한 뒤 추가로 적용된다", () => {
    const c: ParserContract = { acceptedFlags: { "-t": "bool", "-u": "bool" }, supports: args => args.length !== 1 };
    expect(accepts(c, ["-t", "-u"])).toBe(true);
    expect(accepts(c, ["-t"])).toBe(false);
    expect(accepts(c, ["-x", "-t"])).toBe(false);
  });
});

describe("레지스트리의 unsupported_format", () => {
  it("선언 밖의 인자는 parsed=null, reason=unsupported_format이고 메시지가 원인 인자를 밝힌다", () => {
    const registry = new ParserRegistry();
    registry.register("tool", () => ({ ok: true }), { acceptedFlags: { "-a": "bool" } });
    expect(registry.parse("tool", ["-a"], "x").parsed).toEqual({ ok: true });
    const r = registry.parse("tool", ["-b"], "x");
    expect(r.parsed).toBeNull();
    expect(r.parse_error).toMatchObject({ reason: "unsupported_format", message: expect.stringContaining("'-b'") });
  });
});

describe("내장 파서 허용 형식", () => {
  const reg = createRegistry();
  /** 형식 검사만 본다. 원본은 비워 두고 unsupported_format 여부만 확인한다. */
  const unsupported = (cmd: string, args: string[]): boolean => reg.parse(cmd, args, "").parse_error?.reason === "unsupported_format";

  it.each<[string, string[]]>([
    ["ls", ["-l"]], ["ls", ["-la", "/etc"]], ["ls", ["-ltr"]], ["ls", ["--format=long"]], ["ls", ["-l", "--color=never"]],
    ["ls", ["-lR"]], ["ls", ["-lF"]], ["ls", ["-lp"]], ["ls", ["-l", "a", "b"]], ["ls", ["-l", "--time-style=long-iso"]], ["ls", ["-l", "--full-time"]], ["find", [".", "-name", "*.ts", "-type", "f"]], ["stat", ["a.txt"]], ["stat", ["a", "b"]], ["du", ["-sh", "dir"]], ["du", ["-d", "1"]],
    ["df", ["-h"]], ["df", []], ["df", ["-m"]], ["df", ["-B1M"]], ["df", ["-T"]], ["df", ["-hT"]], ["df", ["-B", "1K"]], ["ps", ["aux"]], ["ps", ["aux", "--sort=-%cpu"]], ["ps", ["auxf"]], ["ps", ["aux", "--no-headers"]], ["ps", ["aux", "--forest"]], ["find", [".", "-print0"]], ["du", ["--time"]], ["du", ["-0"]], ["curl", ["-sIL", "http://example.com"]], ["env", ["-0"]], ["ping", ["-c", "2", "host"]],
    ["curl", ["-sI", "https://example.com"]], ["netstat", ["-tlnp"]], ["ss", ["-tuln"]], ["ss", ["-4"]], ["ss", ["-a"]], ["ss", ["-H"]], ["ss", ["-tlnp"]], ["ss", ["-tum"]], ["ss", ["-x"]], ["lsof", ["-p", "1"]], ["lsof", ["-c", "bash"]],
    ["lsof", ["-i", "-n", "-P"]], ["lsof", ["-iTCP", "-sTCP:LISTEN"]], ["dig", ["example.com", "MX"]], ["dig", ["+noquestion", "example.com"]], ["dig", ["+multi", "example.com"]], ["dig", ["+noall", "+answer", "example.com"]], ["dig", ["+nocmd", "example.com"]], ["dig", ["+tcp", "@1.1.1.1", "example.com"]],
    ["grep", ["-rn", "x", "."]], ["grep", ["-c", "x", "a", "b"]], ["grep", ["-nA1", "x", "f"]], ["grep", ["-b", "x", "f"]], ["grep", ["-Zl", "x", "f"]], ["grep", ["-L", "x", "f"]], ["wc", ["-l", "a", "b"]], ["env", []], ["pwd", []], ["which", ["-a", "ls"]],
    ["free", ["-m"]], ["free", ["-h"]], ["free", ["--si"]], ["free", ["-ht"]], ["free", ["--human"]], ["free", ["--giga"]], ["uname", ["-a"]], ["id", []], ["id", ["-u"]], ["systemctl", ["list-units", "--type=service"]], ["systemctl", ["--failed"]],
    ["systemctl", ["list-units", "--all", "--plain"]], ["systemctl", ["list-units", "--all"]], ["systemctl", ["list-units", "--state=inactive"]],
    ["systemctl", ["list-units", "--no-legend"]], ["journalctl", ["-n", "20"]], ["journalctl", ["-o", "short-iso", "--no-hostname"]], ["journalctl", ["-o", "short-full", "-n", "5"]], ["systemctl", ["--user", "list-units", "--state=running"]],
    ["journalctl", ["-o", "short-iso", "-n", "20"]], ["apt", ["list", "--installed"]], ["apt", ["list"]], ["apt", ["list", "-a", "bash"]], ["apt", ["search", "--names-only", "x"]], ["apt", ["search", "x"]], ["npm", ["ls"]], ["npm", ["ls", "--depth=0"]], ["npm", ["ls", "--all"]], ["npm", ["ls", "--depth=2", "--omit=dev"]], ["npm", ["ls", "zod"]],
    ["docker", ["ps", "-a"]], ["docker", ["stats", "--no-stream"]], ["docker", ["stats", "--no-stream", "--no-trunc"]], ["gh", ["pr", "list", "--json", "number,title"]], ["kubectl", ["get", "pods", "-o", "wide"]], ["helm", ["list"]],
    ["git", ["status"]], ["git", ["--no-pager", "log", "--oneline", "-5"]], ["git", ["log", "--format=%h %s"]], ["git", ["branch", "-vv"]],
    ["git", ["diff", "--cached"]], ["git", ["status", "--ignored"]], ["git", ["log", "--oneline", "--decorate"]], ["git", ["branch", "-av"]],
    ["git", ["diff", "--diff-filter=A"]], ["git", ["diff", "-M"]], ["head", ["-n", "5", "f"]], ["cat", ["-A", "f"]],
  ])("%s %j 는 허용한다", (cmd, args) => {
    expect(unsupported(cmd, args)).toBe(false);
  });

  it.each<[string, string[]]>([
    ["ls", ["-lh"]], ["ls", ["-li"]], ["ls", ["-l", "--time-style=+%s"]], ["ls", []], ["ls", ["-l", "--color=always"]], ["ls", ["-R"]],
    ["find", [".", "-ls"]], ["find", [".", "-exec", "ls", "{}", ";"]],
    ["stat", ["-c", "%s", "a"]], ["df", ["-i"]], ["df", ["-BG"]], ["df", ["--output"]],
     ["ps", ["-ef"]],
    ["curl", ["-s", "https://example.com"]], ["netstat", ["-s"]],
    ["ss", ["-s"]], ["ss", ["-t", "state", "established"]], ["lsof", ["-t", "-c", "node"]], ["lsof", ["-F", "p"]],
    ["dig", ["+trace", "example.com"]], ["dig", ["+nocomments", "example.com"]], ["dig", ["+answer", "+noall", "example.com"]], ["dig", ["+noall", "+authority", "example.com"]],
    ["dig", ["+short", "example.com"]],
    ["grep", ["-A1", "x", "f"]], ["grep", ["-C", "2", "x", "f"]], ["grep", ["-2", "x", "f"]], ["grep", ["-Z", "x", "f"]], ["wc", ["a"]], ["wc", ["-lw", "a"]], ["env", ["-i"]], ["free", ["-w"]], ["free", ["--tera"]], ["docker", ["stats"]],
    ["uname", ["-r"]], ["id", ["-un"]], ["systemctl", ["list-unit-files"]],
    ["systemctl", ["status", "cron"]],
    ["journalctl", ["-o", "json"]], ["journalctl", ["-o", "cat", "-n", "5"]],
    ["apt", ["show", "x"]], ["npm", ["ls", "--json"]], 
    ["docker", ["ps", "-q"]], ["docker", ["ps", "--format", "json"]],  ["docker", ["images"]],
    ["gh", ["issue", "list"]], ["kubectl", ["get", "pods", "-o", "json"]], ["kubectl", ["get", "pods", "-A"]], ["cargo", ["tree"]],
    ["git", ["status", "-s"]], ["git", ["log"]],
    ["git", ["log", "--oneline", "--graph"]], ["git", ["branch"]], ["git", ["diff", "--stat"]], ["git", ["show"]],
  ])("%s %j 는 unsupported_format", (cmd, args) => {
    expect(unsupported(cmd, args)).toBe(true);
  });
});
