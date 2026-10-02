import { describe, it, expect } from "vitest";
import { mkdtempSync, realpathSync, symlinkSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { tokenizeArgs, tokenizePolicyless, buildExecArgs, resolvePolicies, policySource, hasPolicy, DEFAULT_POLICIES, BUILD_PROFILE_POLICIES } from "../../src/engine/policy.js";
import { checkGuard, collectPathCandidates, GuardError } from "../../src/engine/guard.js";
import { DEFAULT_CONFIG } from "../../src/config/loader.js";

const root = mkdtempSync(path.join(tmpdir(), "parism-guard-"));
const cfg  = { ...DEFAULT_CONFIG, guard: { ...DEFAULT_CONFIG.guard, allowed_paths: [root] } };
/** 정책이 없는 사용자 추가 명령 */
const plainCfg = { ...cfg, guard: { ...cfg.guard, allowed_commands: [...cfg.guard.allowed_commands, "mytool"] } };
const reason = (fn: () => void) => { try { fn(); return "pass"; } catch (e) { return (e as GuardError).reason; } };

describe("tokenizeArgs", () => {
  it("짧은 플래그 묶음을 분해한다", () => {
    expect(tokenizeArgs(["-la"], { "-l": "bool", "-a": "bool" }).map(t => t.name)).toEqual(["-l", "-a"]);
  });
  it("값을 받는 짧은 플래그는 붙은 값을 분리한다", () => {
    expect(tokenizeArgs(["-n5"], { "-n": "value" })).toEqual([{ kind: "flag", name: "-n", value: "5" }]);
  });
  it("--long=value를 분리한다", () => {
    expect(tokenizeArgs(["--format=%h"], { "--format": "value" })).toEqual([{ kind: "flag", name: "--format", value: "%h" }]);
  });
  it("-- 이후는 모두 위치 인자다", () => {
    expect(tokenizeArgs(["--", "-x"], {}).map(t => t.kind)).toEqual(["positional"]);
  });
  it("singleDashLong이면 -name을 하나의 플래그로 본다", () => {
    expect(tokenizeArgs(["-name", "*.ts"], { "-name": "value" }, true)).toEqual([{ kind: "flag", name: "-name", value: "*.ts" }]);
  });
});

describe("정책 가드", () => {
  it("허용목록에 없는 플래그는 arg_not_allowed", () => {
    expect(reason(() => checkGuard("git", ["log", "--not-a-flag"], root, cfg))).toBe("arg_not_allowed");
  });
  it("허용목록에 없는 서브커맨드는 arg_not_allowed", () => {
    expect(reason(() => checkGuard("git", ["push"], root, cfg))).toBe("arg_not_allowed");
  });
  it("정상 읽기 명령은 통과한다", () => {
    for (const a of [["status", "-sb"], ["log", "--oneline", "-n", "10"], ["log", "-5"], ["--no-pager", "log", "-1"], ["remote", "-v"], ["describe", "--tags"]]) {
      expect(reason(() => checkGuard("git", a, root, cfg))).toBe("pass");
    }
  });
  it("git branch는 위치 인자를 받지 않는다", () => {
    expect(reason(() => checkGuard("git", ["branch", "newname"], root, cfg))).toBe("arg_not_allowed");
  });
  it("env는 인자를 받지 않는다", () => {
    expect(reason(() => checkGuard("env", [], root, cfg))).toBe("pass");
    expect(reason(() => checkGuard("env", ["anything"], root, cfg))).toBe("arg_not_allowed");
  });
  it("curl 위치 인자는 http(s) URL만 허용한다", () => {
    expect(reason(() => checkGuard("curl", ["-sI", "https://example.com"], root, cfg))).toBe("pass");
    expect(reason(() => checkGuard("curl", ["ftp://example.com"], root, cfg))).toBe("arg_not_allowed");
  });
  it("find 허용목록 밖 술어는 차단한다", () => {
    expect(reason(() => checkGuard("find", [".", "-name", "*.ts", "-type", "f"], root, cfg))).toBe("pass");
    expect(reason(() => checkGuard("find", [".", "-delete"], root, cfg))).toBe("arg_not_allowed");
  });
  it("path 종류 플래그 값은 허용 경로 검사를 받는다", () => {
    expect(reason(() => checkGuard("find", [".", "-newer", "/etc/hostname"], root, cfg))).toBe("path_not_allowed");
  });
  it("legacy command: 정책 없는 명령은 플래그에 붙은 경로 값을 검사한다", () => {
    expect(reason(() => checkGuard("grep", ["--file=/etc/hostname", "x", "."], root, cfg))).toBe("path_not_allowed");
    expect(reason(() => checkGuard("grep", ["-rn", "x", "."], root, cfg))).toBe("pass");
  });
  it("허용 경로 안의 symlink가 밖을 가리키면 차단한다", () => {
    const link = path.join(root, "out");
    symlinkSync("/etc", link);
    expect(reason(() => checkGuard("cat", ["out/hostname"], root, cfg))).toBe("path_not_allowed");
  });
  it("build 프로필에서는 npm run이 통과한다", () => {
    const b = { ...cfg, guard: { ...cfg.guard, profile: "build" as const } };
    expect(reason(() => checkGuard("npm", ["run", "build"], root, cfg))).toBe("arg_not_allowed");
    expect(reason(() => checkGuard("npm", ["run", "build"], root, b))).toBe("pass");
  });
  it("command_policies가 기본 정책을 덮어쓴다", () => {
    mkdirSync(path.join(root, "sub"), { recursive: true });
    const c = { ...cfg, guard: { ...cfg.guard, command_policies: { git: { subcommands: ["status"], flags: {}, positionals: "none" as const } } } };
    expect(reason(() => checkGuard("git", ["log"], root, c))).toBe("arg_not_allowed");
  });
});

describe("정책 가드: 보강", () => {
  const build = { ...cfg, guard: { ...cfg.guard, profile: "build" as const, allowed_commands: [...cfg.guard.allowed_commands, "node", "npx", "yarn"] } };

  it("GuardError 메시지는 차단된 인자와 정책 출처를 포함한다", () => {
    const messageOf = (fn: () => void) => { try { fn(); return ""; } catch (e) { return (e as GuardError).message; } };
    const c         = { ...cfg, guard: { ...cfg.guard, command_policies: { git: { subcommands: ["status"], flags: {}, positionals: "none" as const } } } };

    expect(messageOf(() => checkGuard("git", ["log", "--not-a-flag"], root, cfg))).toContain("--not-a-flag");
    expect(messageOf(() => checkGuard("git", ["log", "--not-a-flag"], root, cfg))).toContain("default");
    expect(messageOf(() => checkGuard("npm", ["run", "build", "--not-a-flag"], root, build))).toContain("build");
    expect(messageOf(() => checkGuard("git", ["log"], root, c))).toContain("config");
  });

  it("build 프로필은 목록에 있는 서브커맨드만 추가한다", () => {
    const pass = [
      ["npm", ["test"]], ["npm", ["ci"]], ["npm", ["ls"]],
      ["cargo", ["build"]], ["cargo", ["test"]], ["cargo", ["check"]],
      ["terraform", ["plan"]], ["terraform", ["init"]],
      ["docker", ["compose", "ps"]], ["docker", ["compose", "logs"]],
    ] as const;
    for (const [cmd, a] of pass) expect(reason(() => checkGuard(cmd, [...a], root, build))).toBe("pass");

    const denied = [
      ["npm", ["install"]], ["npm", ["exec", "x"]], ["cargo", ["run"]], ["cargo", ["install", "x"]],
      ["terraform", ["apply"]], ["terraform", ["destroy"]],
      ["docker", ["compose", "up"]], ["docker", ["compose", "exec", "web", "sh"]], ["docker", ["compose"]], ["docker", ["run", "x"]],
    ] as const;
    for (const [cmd, a] of denied) expect(reason(() => checkGuard(cmd, [...a], root, build))).toBe("arg_not_allowed");
  });

  it("terraform 기본 정책은 version만 허용하고 provider를 불러올 수 있는 서브커맨드는 build 프로필에 둔다", () => {
    expect(reason(() => checkGuard("terraform", ["version", "-json"], root, cfg))).toBe("pass");
    for (const sub of ["show", "validate", "providers", "plan", "init"]) {
      expect(reason(() => checkGuard("terraform", [sub], root, cfg))).toBe("arg_not_allowed");
    }
    for (const a of [["show", "-json"], ["validate", "-no-color"], ["providers"], ["version"]]) {
      expect(reason(() => checkGuard("terraform", a, root, build))).toBe("pass");
    }
    expect(reason(() => checkGuard("terraform", ["show", "-json", "../outside.tfplan"], root, build))).toBe("path_not_allowed");
    expect(reason(() => checkGuard("terraform", ["validate", "extra"], root, build))).toBe("arg_not_allowed");
  });

  it("build 프로필의 node 위치 인자는 경로 검사를 받는다", () => {
    expect(reason(() => checkGuard("node", ["dist/index.js"], root, build))).toBe("pass");
    expect(reason(() => checkGuard("node", ["../evil.js"], root, build))).toBe("path_not_allowed");
    expect(reason(() => checkGuard("node", ["--inspect", "dist/index.js"], root, build))).toBe("arg_not_allowed");
  });

  it("build 프로필의 npx는 위치 인자를 받는다", () => {
    expect(reason(() => checkGuard("npx", ["vitest", "run"], root, build))).toBe("pass");
    expect(reason(() => checkGuard("npx", ["vitest", "run"], root, { ...build, guard: { ...build.guard, profile: "readonly" as const } }))).toBe("arg_not_allowed");
  });

  it("gh는 하위 동사 허용목록을 적용한다", () => {
    expect(reason(() => checkGuard("gh", ["pr", "list"], root, cfg))).toBe("pass");
    expect(reason(() => checkGuard("gh", ["status"], root, cfg))).toBe("pass");
    expect(reason(() => checkGuard("gh", ["pr", "merge", "1"], root, cfg))).toBe("arg_not_allowed");
    expect(reason(() => checkGuard("gh", ["pr"], root, cfg))).toBe("arg_not_allowed");
  });

  it("resolvePolicies 우선순위는 command_policies, build 프로필, 기본 순이다", () => {
    expect(resolvePolicies(cfg.guard).npm).toBe(DEFAULT_POLICIES.npm);
    expect(resolvePolicies({ ...cfg.guard, profile: "build" }).npm).toBe(BUILD_PROFILE_POLICIES.npm);
    const own = { flags: {}, positionals: "none" as const };
    expect(resolvePolicies({ ...cfg.guard, profile: "build", command_policies: { npm: own } }).npm).toBe(own);
  });

  it("BUILD_PROFILE_POLICIES는 목록에 있는 명령만 정의한다", () => {
    expect(Object.keys(BUILD_PROFILE_POLICIES).sort()).toEqual(["cargo", "docker", "node", "npm", "npx", "pnpm", "terraform", "yarn"]);
  });
});

describe("인자 분류 규칙", () => {
  const build = { ...cfg, guard: { ...cfg.guard, profile: "build" as const, allowed_commands: [...cfg.guard.allowed_commands, "node", "npx", "yarn"] } };

  it("숫자 축약 플래그는 플래그 자리에서만 인식하고 토큰을 버리지 않는다", () => {
    expect(tokenizeArgs(["-5", "x"], {}, false, { numericFlag: true })).toEqual([
      { kind: "flag", name: "-5" }, { kind: "positional", name: "x" },
    ]);
    expect(tokenizeArgs(["-12"], {}, false, { numericFlag: true })).toEqual([{ kind: "flag", name: "-12" }]);
    expect(tokenizeArgs(["--format", "-5", "x"], { "--format": "value" }, false, { numericFlag: true })).toEqual([
      { kind: "flag", name: "--format", value: "-5" }, { kind: "positional", name: "x" },
    ]);
  });

  it("값 플래그 뒤의 숫자 축약 인자는 값으로 소비되고 다음 위치 인자는 위치 인자 규칙을 받는다", () => {
    expect(reason(() => checkGuard("git", ["branch", "--format", "-5", "newname"], root, cfg))).toBe("arg_not_allowed");
    expect(reason(() => checkGuard("git", ["tag", "--format", "-1", "v9"], root, cfg))).toBe("arg_not_allowed");
    expect(reason(() => checkGuard("git", ["log", "--oneline", "-3", "HEAD"], root, cfg))).toBe("pass");
  });

  it("숫자 축약 플래그는 numericFlag 정책에서만 허용된다", () => {
    expect(reason(() => checkGuard("docker", ["ps", "-5"], root, cfg))).toBe("arg_not_allowed");
  });

  it("정책 없는 명령: 짧은 플래그 묶음 중간 글자에 붙은 경로 값을 검사한다", () => {
    expect(reason(() => checkGuard("mytool", ["-rf/etc/hostname", "."], root, plainCfg))).toBe("path_not_allowed");
    expect(reason(() => checkGuard("mytool", ["-ea/b", "."], root, plainCfg))).toBe("path_not_allowed");
    expect(reason(() => checkGuard("mytool", ["-rnA3", "-e.x", "."], root, plainCfg))).toBe("pass");
  });

  it("정책 없는 명령: --x= 값이 ./ 또는 슬래시를 포함한 상대경로면 검사한다", () => {
    expect(reason(() => checkGuard("grep", ["--file=./../../etc/hostname", "x", "."], root, cfg))).toBe("path_not_allowed");
    expect(reason(() => checkGuard("grep", ["--file=sub/../../etc/hostname", "x", "."], root, cfg))).toBe("path_not_allowed");
    expect(reason(() => checkGuard("grep", ["--file=./patterns.txt", "x", "."], root, cfg))).toBe("pass");
    expect(reason(() => checkGuard("grep", ["--include=*.ts", "-rn", "x", "."], root, cfg))).toBe("pass");
  });

  it("curl의 파일 참조(@) 값은 허용하지 않는다", () => {
    for (const a of [["-H", "@/etc/hostname", "https://example.com"], ["--header=@h.txt", "https://example.com"], ["-sH@h.txt", "https://example.com"], ["-w", "@fmt.txt", "https://example.com"], ["--write-out=@fmt.txt", "https://example.com"]]) {
      expect(reason(() => checkGuard("curl", a, root, cfg))).toBe("arg_not_allowed");
    }
    expect(reason(() => checkGuard("curl", ["-H", "Accept: text/plain", "-w", "%{http_code}", "https://example.com"], root, cfg))).toBe("pass");
  });

  it("curl의 write-out 값에 %output{ 지시어가 있으면 허용하지 않는다", () => {
    for (const a of [["-w", "%output{/tmp/x}%{http_code}", "https://example.com"], ["--write-out=%output{/tmp/y}", "https://example.com"], ["-sw%output{/tmp/x}", "https://example.com"]]) {
      expect(reason(() => checkGuard("curl", a, root, cfg))).toBe("arg_not_allowed");
    }
  });

  it("pnpm 기본 정책은 조회 서브커맨드만 허용한다", () => {
    for (const a of [["list"], ["why", "react"], ["outdated"]]) {
      expect(reason(() => checkGuard("pnpm", a, root, cfg))).toBe("pass");
    }
    for (const a of [["run", "build"], ["dlx", "x"], ["exec", "x"]]) {
      expect(reason(() => checkGuard("pnpm", a, root, cfg))).toBe("arg_not_allowed");
    }
  });

  it("yarn은 기본 정책과 기본 허용 명령에 없고 build 프로필에서만 실행된다", () => {
    expect(DEFAULT_POLICIES.yarn).toBeUndefined();
    expect(DEFAULT_CONFIG.guard.allowed_commands).not.toContain("yarn");
    const readonlyWithYarn = { ...cfg, guard: { ...cfg.guard, allowed_commands: [...cfg.guard.allowed_commands, "yarn"] } };
    for (const a of [["info", "react"], ["--version"], ["run", "build"]]) {
      expect(reason(() => checkGuard("yarn", a, root, readonlyWithYarn))).toBe("command_not_allowed");
      expect(reason(() => checkGuard("yarn", a, root, cfg))).toBe("command_not_allowed");
    }
    expect(reason(() => checkGuard("yarn", ["info", "react"], root, build))).toBe("pass");
  });

  it("build 프로필에서 pnpm, yarn은 run과 test를 추가로 허용한다", () => {
    for (const [cmd, a] of [["pnpm", ["run", "build"]], ["pnpm", ["test"]], ["yarn", ["run", "build"]], ["yarn", ["test"]], ["pnpm", ["list"]]] as const) {
      expect(reason(() => checkGuard(cmd, [...a], root, build))).toBe("pass");
    }
    for (const [cmd, a] of [["pnpm", ["install"]], ["yarn", ["add", "x"]]] as const) {
      expect(reason(() => checkGuard(cmd, [...a], root, build))).toBe("arg_not_allowed");
    }
  });

  it("build 프로필의 node, npx는 첫 위치 인자 이후 플래그를 검사하지 않는다", () => {
    expect(reason(() => checkGuard("npx", ["tsc", "--noEmit"], root, build))).toBe("pass");
    expect(reason(() => checkGuard("node", ["dist/index.js", "--port", "1"], root, build))).toBe("pass");
    expect(reason(() => checkGuard("npx", ["--foo", "tsc"], root, build))).toBe("arg_not_allowed");
    expect(reason(() => checkGuard("node", ["--inspect", "dist/index.js"], root, build))).toBe("arg_not_allowed");
    expect(reason(() => checkGuard("node", ["../evil.js", "--port", "1"], root, build))).toBe("path_not_allowed");
  });

  it("stopAtPositional이면 첫 위치 인자 이후 인자는 passthrough로 분류한다", () => {
    expect(tokenizeArgs(["-v", "a.js", "--x", "y"], { "-v": "bool" }, false, { stopAtPositional: true })).toEqual([
      { kind: "flag", name: "-v" },
      { kind: "positional", name: "a.js" },
      { kind: "positional", name: "--x", passthrough: true },
      { kind: "positional", name: "y", passthrough: true },
    ]);
  });
});

describe("buildExecArgs", () => {
  it("blame에는 --no-textconv만 주입된다", () => {
    expect(buildExecArgs("git", ["blame", "f.ts"])).toEqual(
      ["-c", "core.fsmonitor=false", "-c", "core.pager=cat", "blame", "--no-textconv", "f.ts"],
    );
  });

  it("유효 git 정책의 leadingFlags를 기준으로 서브커맨드를 찾는다", () => {
    const guard = { ...cfg.guard, command_policies: { git: { ...DEFAULT_POLICIES.git!, leadingFlags: ["--no-pager", "--literal-pathspecs"] } } };
    expect(buildExecArgs("git", ["--literal-pathspecs", "log"], guard)).toEqual(
      ["-c", "core.fsmonitor=false", "-c", "core.pager=cat", "--literal-pathspecs", "log", "--no-textconv", "--no-ext-diff"],
    );
    expect(buildExecArgs("git", ["--literal-pathspecs", "log"])).toEqual(
      ["-c", "core.fsmonitor=false", "-c", "core.pager=cat", "--literal-pathspecs", "log"],
    );
  });

  it("git 실행 인자에 저장소 설정 무력화 옵션이 주입된다", () => {
    expect(buildExecArgs("git", ["diff", "--stat"])).toEqual(
      ["-c", "core.fsmonitor=false", "-c", "core.pager=cat", "diff", "--no-textconv", "--no-ext-diff", "--stat"],
    );
    expect(buildExecArgs("ls", ["-l"])).toEqual(["-l"]);
  });

  it("앞선 전역 플래그를 건너뛰고 서브커맨드를 찾는다", () => {
    expect(buildExecArgs("git", ["--no-pager", "log", "-1"])).toEqual(
      ["-c", "core.fsmonitor=false", "-c", "core.pager=cat", "--no-pager", "log", "--no-textconv", "--no-ext-diff", "-1"],
    );
  });

  it("log, show, diff 외 서브커맨드에는 textconv 옵션을 붙이지 않는다", () => {
    expect(buildExecArgs("git", ["status", "-sb"])).toEqual(
      ["-c", "core.fsmonitor=false", "-c", "core.pager=cat", "status", "-sb"],
    );
  });

  it("프로토타입 키 서브커맨드도 예외 없이 처리한다", () => {
    for (const sub of ["constructor", "__proto__", "toString", "hasOwnProperty"]) {
      expect(buildExecArgs("git", [sub])).toEqual(["-c", "core.fsmonitor=false", "-c", "core.pager=cat", sub]);
    }
  });

  it("입력 배열을 변경하지 않는다", () => {
    const args = ["show", "HEAD"];
    buildExecArgs("git", args);
    expect(args).toEqual(["show", "HEAD"]);
  });
});

describe("값을 붙여서만 받는 플래그", () => {
  it("attached 플래그는 다음 인자를 값으로 소비하지 않는다", () => {
    const flags = { "--pretty": "attached", "-U": "attached" } as const;
    expect(tokenizeArgs(["--pretty", "--x"], flags)).toEqual([{ kind: "flag", name: "--pretty" }, { kind: "flag", name: "--x" }]);
    expect(tokenizeArgs(["-U", "y"], flags)).toEqual([{ kind: "flag", name: "-U" }, { kind: "positional", name: "y" }]);
    expect(tokenizeArgs(["-U3", "--pretty=oneline"], flags)).toEqual([
      { kind: "flag", name: "-U", value: "3" }, { kind: "flag", name: "--pretty", value: "oneline" },
    ]);
  });

  it("git --pretty, --format, -U, --unified 뒤의 인자는 따로 허용목록 검사를 받는다", () => {
    for (const sub of ["log", "show", "diff"]) {
      for (const flag of ["--pretty", "--format", "-U", "--unified"]) {
        expect(reason(() => checkGuard("git", [sub, flag, "--no-such-option"], root, cfg))).toBe("arg_not_allowed");
      }
    }
    for (const a of [["log", "--pretty=oneline"], ["log", "--format=%h %s"], ["log", "--pretty"], ["diff", "-U3"], ["diff", "--unified=5"], ["show", "-U0", "HEAD"]]) {
      expect(reason(() => checkGuard("git", a, root, cfg))).toBe("pass");
    }
  });

  it("git blame, shortlog의 -n은 값을 받지 않는다", () => {
    expect(reason(() => checkGuard("git", ["blame", "-n", "--no-such-option", "f.ts"], root, cfg))).toBe("arg_not_allowed");
    expect(reason(() => checkGuard("git", ["shortlog", "-n", "--no-such-option"], root, cfg))).toBe("arg_not_allowed");
    expect(reason(() => checkGuard("git", ["blame", "-n", "f.ts"], root, cfg))).toBe("pass");
    expect(reason(() => checkGuard("git", ["shortlog", "-sn"], root, cfg))).toBe("pass");
    expect(reason(() => checkGuard("git", ["log", "-n", "5"], root, cfg))).toBe("pass");
  });

  it("git branch, tag의 --format은 다음 인자를 값으로 받고 tag -n은 붙은 값만 받는다", () => {
    expect(reason(() => checkGuard("git", ["branch", "--format", "%(refname)"], root, cfg))).toBe("pass");
    expect(reason(() => checkGuard("git", ["tag", "--format", "%(refname)"], root, cfg))).toBe("pass");
    expect(reason(() => checkGuard("git", ["tag", "-n5"], root, cfg))).toBe("pass");
    expect(reason(() => checkGuard("git", ["tag", "-n", "--no-such-option"], root, cfg))).toBe("arg_not_allowed");
  });

  it("docker logs의 -f는 값을 받지 않고 ps의 -f는 값을 받는다", () => {
    expect(reason(() => checkGuard("docker", ["logs", "-f", "--no-such-option", "web"], root, cfg))).toBe("arg_not_allowed");
    expect(reason(() => checkGuard("docker", ["logs", "-f", "web"], root, cfg))).toBe("pass");
    expect(reason(() => checkGuard("docker", ["ps", "-f", "status=running"], root, cfg))).toBe("pass");
  });

  it("build 프로필의 docker compose -f 값은 경로 검사를 받는다", () => {
    const build = { ...cfg, guard: { ...cfg.guard, profile: "build" as const } };
    expect(reason(() => checkGuard("docker", ["compose", "-f", "compose.yml", "ps"], root, build))).toBe("pass");
    expect(reason(() => checkGuard("docker", ["compose", "-f", "../outside.yml", "ps"], root, build))).toBe("path_not_allowed");
  });

  it("journalctl -n, --lines는 줄 수 형식의 다음 인자만 값으로 받는다", () => {
    for (const a of [["-n", "20"], ["-n", "+5"], ["--lines", "all"], ["-n20"], ["--lines=20"], ["-n"]]) {
      expect(reason(() => checkGuard("journalctl", [...a, "--no-pager"], root, cfg))).toBe("pass");
    }
    expect(reason(() => checkGuard("journalctl", ["-n", "--no-such-option"], root, cfg))).toBe("arg_not_allowed");
    expect(reason(() => checkGuard("journalctl", ["--lines", "--no-such-option"], root, cfg))).toBe("arg_not_allowed");
    expect(tokenizeArgs(["-n", "x"], { "-n": "count" })).toEqual([{ kind: "flag", name: "-n" }, { kind: "positional", name: "x" }]);
  });

  it("brew --json은 붙은 값만 받는다", () => {
    expect(reason(() => checkGuard("brew", ["info", "--json", "--no-such-option"], root, cfg))).toBe("arg_not_allowed");
    expect(reason(() => checkGuard("brew", ["info", "--json=v2", "wget"], root, cfg))).toBe("pass");
  });
});

describe("조회 정책 범위", () => {
  const build = { ...cfg, guard: { ...cfg.guard, profile: "build" as const } };

  it("npm audit은 위치 인자를 받지 않는다", () => {
    for (const a of [["audit"], ["audit", "--json"]]) {
      expect(reason(() => checkGuard("npm", a, root, cfg))).toBe("pass");
    }
    for (const g of [cfg, build]) {
      for (const a of [["audit", "fix"], ["audit", "fix", "-g"], ["audit", "signatures"]]) {
        expect(reason(() => checkGuard("npm", a, root, g))).toBe("arg_not_allowed");
      }
    }
  });

  it("cargo 기본 정책은 버전 조회만 허용하고 나머지 조회는 build 프로필에 둔다", () => {
    for (const a of [["--version"], ["-V"]]) expect(reason(() => checkGuard("cargo", a, root, cfg))).toBe("pass");
    for (const a of [["tree"], ["metadata", "--no-deps"], ["search", "serde"], ["pkgid"]]) {
      expect(reason(() => checkGuard("cargo", a, root, cfg))).toBe("arg_not_allowed");
      expect(reason(() => checkGuard("cargo", a, root, build))).toBe("pass");
    }
    expect(reason(() => checkGuard("cargo", ["tree", "--depth", "1"], root, build))).toBe("pass");
  });

  it("kubectl -o는 열거된 출력 형식만 허용한다", () => {
    for (const a of [["-o", "json"], ["-o", "wide"], ["-oyaml"], ["-ojsonpath={.items[*].metadata.name}"], ["--output=custom-columns=NAME:.metadata.name"], ["--output", "go-template={{.kind}}"]]) {
      expect(reason(() => checkGuard("kubectl", ["get", "pods", ...a], root, cfg))).toBe("pass");
    }
    for (const a of [["-o", "jsonpath-file=f"], ["--output=custom-columns-file=f"], ["-ogo-template-file=f"], ["-o", "templatefile=f"], ["-o", "unknown"]]) {
      expect(reason(() => checkGuard("kubectl", ["get", "pods", ...a], root, cfg))).toBe("arg_not_allowed");
    }
  });

  it("find 정책은 심볼릭 링크를 따라가는 -L을 허용하지 않는다", () => {
    expect(reason(() => checkGuard("find", ["-L", "."], root, cfg))).toBe("arg_not_allowed");
    expect(reason(() => checkGuard("find", ["-P", "."], root, cfg))).toBe("pass");
  });
});

describe("npx 실행 인자", () => {
  it("npx에는 설치된 실행 파일만 쓰도록 --no를 앞에 붙인다", () => {
    const args = ["vitest", "run"];
    expect(buildExecArgs("npx", args)).toEqual(["--no", "vitest", "run"]);
    expect(args).toEqual(["vitest", "run"]);
  });
});

describe("정책 조회와 객체 프로토타입 키", () => {
  const protoKeys = ["constructor", "toString", "hasOwnProperty", "__proto__"];

  it("프로토타입 키 이름의 명령은 정책을 갖지 않는다", () => {
    const policies = resolvePolicies({ ...cfg.guard, profile: "build" });
    for (const k of protoKeys) {
      expect(policies[k]).toBeUndefined();
      expect(policySource({ ...cfg.guard, profile: "build" }, k)).toBeUndefined();
    }
  });

  it("프로토타입 키 이름의 명령은 정책 없는 명령으로 검사된다", () => {
    const c = { ...cfg, guard: { ...cfg.guard, allowed_commands: [...cfg.guard.allowed_commands, ...protoKeys] } };
    for (const k of protoKeys) expect(reason(() => checkGuard(k, ["-x"], root, c))).toBe("pass");
  });

  it("command_policies의 명령 정책은 그대로 적용된다", () => {
    const own = { flags: {}, positionals: "none" as const };
    expect(resolvePolicies({ ...cfg.guard, command_policies: { mytool: own } }).mytool).toBe(own);
  });
});

describe("정책 없는 명령의 경로 검사", () => {
  const base    = mkdtempSync(path.join(tmpdir(), "parism-plain-"));
  const outside = mkdtempSync(path.join(tmpdir(), "parism-plain-out-"));
  const c       = { ...DEFAULT_CONFIG, guard: { ...DEFAULT_CONFIG.guard, allowed_paths: [base], allowed_commands: [...DEFAULT_CONFIG.guard.allowed_commands, "mytool"] } };
  symlinkSync(outside, path.join(base, "ext"));
  writeFileSync(path.join(base, "inner"), "x");

  it("슬래시를 포함한 위치 인자는 경로 검사를 받는다", () => {
    expect(reason(() => checkGuard("mytool", ["-f", "a/../../x"], base, c))).toBe("path_not_allowed");
    expect(reason(() => checkGuard("mytool", ["-f", "sub/inner"], base, c))).toBe("pass");
  });

  it("허용 경로 밖을 가리키는 링크 이름은 위치 인자와 붙은 값 모두 차단한다", () => {
    for (const a of [["-f", "ext"], ["-fext"], ["--file=ext"]]) {
      expect(reason(() => checkGuard("mytool", a, base, c))).toBe("path_not_allowed");
    }
  });

  it("허용 경로 안의 항목과 경로가 아닌 값은 통과한다", () => {
    for (const a of [["-finner"], ["--file=inner"], ["+%Y/%m/%d"], ["-u"]]) {
      expect(reason(() => checkGuard("mytool", a, base, c))).toBe("pass");
    }
    expect(reason(() => checkGuard("echo", ["hello", "a/b"], base, c))).toBe("pass");
  });
});

describe("정책 명령의 경로 후보", () => {
  const base    = realpathSync(mkdtempSync(path.join(tmpdir(), "parism-cand-")));
  const outside = mkdtempSync(path.join(tmpdir(), "parism-cand-out-"));
  const c       = { ...DEFAULT_CONFIG, guard: { ...DEFAULT_CONFIG.guard, allowed_paths: [base] } };
  symlinkSync(outside, path.join(base, "ext"));
  symlinkSync(outside, path.join(base, "list"));
  mkdirSync(path.join(base, "sub"));
  symlinkSync(path.join(base, "sub"), path.join(base, "near"));

  const cases: [string, string[]][] = [
    ["systemctl", ["status", "unit/../../x"]],
    ["systemctl", ["status", "ext"]],
    ["apt",       ["show", "pkg/../../x"]],
    ["apt",       ["show", "ext"]],
    ["gh",        ["pr", "view", "a/../../x"]],
    ["gh",        ["pr", "view", "ext"]],
  ];

  for (const [cmd, args] of cases) {
    it(`${cmd} ${args.join(" ")}: 허용 경로 밖으로 해석되는 위치 인자는 차단한다`, () => {
      expect(reason(() => checkGuard(cmd, args, base, c))).toBe("path_not_allowed");
    });
  }

  it("정책 명령의 값 플래그도 허용 경로 밖으로 해석되면 차단한다", () => {
    expect(reason(() => checkGuard("gh", ["pr", "list", "-R", "a/../../x"], base, c))).toBe("path_not_allowed");
    expect(reason(() => checkGuard("systemctl", ["show", "--property=ext"], base, c))).toBe("path_not_allowed");
  });

  it("허용 경로 안을 가리키는 이름과 경로가 아닌 값은 통과한다", () => {
    expect(reason(() => checkGuard("systemctl", ["status", "nginx", "--no-pager"], base, c))).toBe("pass");
    expect(reason(() => checkGuard("systemctl", ["status", "near"], base, c))).toBe("pass");
    expect(reason(() => checkGuard("apt", ["show", "sub/x"], base, c))).toBe("pass");
    expect(reason(() => checkGuard("gh", ["pr", "list", "-R", "owner/repo"], base, c))).toBe("pass");
  });

  it("하위 동사 자리의 인자는 경로 후보가 아니다", () => {
    expect(reason(() => checkGuard("gh", ["pr", "list"], base, c))).toBe("pass");
  });
});

describe("collectPathCandidates", () => {
  const base = realpathSync(mkdtempSync(path.join(tmpdir(), "parism-collect-")));
  writeFileSync(path.join(base, "present"), "x");
  const policy = { flags: { "-f": "path" as const, "-n": "value" as const, "-q": "bool" as const }, positionals: "any" as const };

  it("경로형이거나 존재하는 항목을 가리키는 위치 인자와 플래그 값을 모은다", () => {
    const tokens = tokenizeArgs(["-n", "present", "word", "a/b", ".hidden", "~x", "-q"], policy.flags);
    expect(collectPathCandidates(tokens, policy, base)).toEqual(["present", "a/b", ".hidden", "~x"]);
  });

  it("path 종류 플래그 값과 path 위치 인자는 형식과 관계없이 모은다", () => {
    const tokens = tokenizeArgs(["-f", "word", "name"], policy.flags);
    expect(collectPathCandidates(tokens, { ...policy, positionals: "path" }, base)).toEqual(["word", "name"]);
  });

  it("정책이 없으면 짧은 플래그 묶음의 각 글자 뒤 나머지를 값 후보로 본다", () => {
    expect(collectPathCandidates(tokenizePolicyless(["-abc/x", "--k=./y", "plain", "-", "--"]), undefined, base))
      .toEqual(["bc/x", "c/x", "/x", "./y"]);
  });

  it("stopAtPositional 이후 인자도 정책 없는 규칙으로 검사한다", () => {
    const flags  = { "--version": "bool" as const };
    const tokens = tokenizeArgs(["script.js", "--out=/x", "../y"], flags, false, { stopAtPositional: true });
    expect(collectPathCandidates(tokens, { flags, positionals: "path", stopAtPositional: true }, base))
      .toEqual(["script.js", "/x", "../y"]);
  });
});

describe("기본 허용 명령 정책", () => {
  it("기본 allowed_commands의 모든 명령은 두 프로필에서 유효 정책을 가진다", () => {
    for (const profile of ["readonly", "build"] as const) {
      const table   = resolvePolicies({ ...DEFAULT_CONFIG.guard, profile });
      const missing = DEFAULT_CONFIG.guard.allowed_commands.filter(c => !hasPolicy(table, c));
      expect(missing).toEqual([]);
    }
  });

  it("읽기 용도의 일반 인자는 통과한다", () => {
    const ok: [string, string[]][] = [
      ["ls", ["-la"]], ["ls", ["-lah", "--group-directories-first", "sub"]], ["ls", ["-1", "--sort=time"]],
      ["stat", ["-c", "%n %s", "f"]], ["du", ["-sh", "--max-depth=1", "sub"]], ["df", ["-hT", "--output=source,size"]],
      ["tree", ["-L", "2", "-a", "--dirsfirst", "sub"]], ["ps", ["aux"]], ["ps", ["-ef"]], ["ps", ["-o", "pid,comm", "-p", "1"]],
      ["ping", ["-c", "3", "-W", "2", "example.com"]], ["netstat", ["-tlnp"]], ["lsof", ["-i", ":8080"]], ["lsof", ["-nP", "-iTCP", "-sTCP:LISTEN"]],
      ["ss", ["-tuln"]], ["ss", ["-tanp", "state", "established"]], ["dig", ["+short", "example.com", "A"]], ["dig", ["-x", "127.0.0.1"]],
      ["grep", ["-rn", "x", "."]], ["grep", ["-rl", "--include=*.ts", "-e", "x", "."]], ["grep", ["-5", "-i", "x", "f"]],
      ["wc", ["-l", "f"]], ["head", ["-n", "20", "f"]], ["head", ["-20", "f"]], ["tail", ["-n", "+5", "f"]], ["cat", ["-n", "f"]],
      ["pwd", []], ["pwd", ["-P"]], ["which", ["-a", "node"]], ["echo", ["hello"]], ["date", []], ["date", ["-u", "-Iseconds"]],
      ["uname", ["-a"]], ["hostname", []], ["hostname", ["-f"]], ["free", ["-h"]], ["free", ["-m"]], ["id", []], ["id", ["-u"]], ["id", ["-Gn", "root"]],
    ];
    for (const [cmd, args] of ok) {
      expect([cmd, args, reason(() => checkGuard(cmd, args, root, cfg))]).toEqual([cmd, args, "pass"]);
    }
  });

  it("출력 파일, 상태 변경, 끝나지 않는 실행, 링크를 따라가는 재귀 옵션은 허용하지 않는다", () => {
    const denied: [string, string[]][] = [
      ["tree", ["-o", "x"]], ["tree", ["-R"]], ["tree", ["-l"]], ["ss", ["-D", "x"]], ["ss", ["-K"]], ["ss", ["-E"]],
      ["hostname", ["name"]], ["hostname", ["-F", "x"]], ["hostname", ["-b"]], ["date", ["-s", "x"]], ["date", ["--set=x"]],
      ["date", ["+%Y"]], ["tail", ["-f", "x"]], ["tail", ["--follow", "x"]], ["ping", ["-f", "example.com"]], ["free", ["-s", "1"]],
      ["netstat", ["-c"]], ["lsof", ["-r"]], ["grep", ["-R", "x", "."]], ["du", ["-L", "."]], ["ls", ["-L", "."]],
      ["dig", ["-f", "x"]], ["dig", ["-k", "x"]], ["uname", ["x"]], ["pwd", ["x"]], ["free", ["x"]], ["netstat", ["x"]],
    ];
    for (const [cmd, args] of denied) {
      expect([cmd, args, reason(() => checkGuard(cmd, args, root, cfg))]).toEqual([cmd, args, "arg_not_allowed"]);
    }
  });

  it("path 종류 플래그 값은 경로 검사를 받는다", () => {
    expect(reason(() => checkGuard("grep", ["-f", "/etc/hostname", "x", "."], root, cfg))).toBe("path_not_allowed");
    expect(reason(() => checkGuard("date", ["-r", "/etc/hostname"], root, cfg))).toBe("path_not_allowed");
  });
});
