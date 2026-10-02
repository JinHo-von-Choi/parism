import { describe, it, expect } from "vitest";
import { mkdtempSync, symlinkSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { tokenizeArgs, buildExecArgs, resolvePolicies, DEFAULT_POLICIES, BUILD_PROFILE_POLICIES } from "../../src/engine/policy.js";
import { checkGuard, GuardError } from "../../src/engine/guard.js";
import { DEFAULT_CONFIG } from "../../src/config/loader.js";

const root = mkdtempSync(path.join(tmpdir(), "parism-guard-"));
const cfg  = { ...DEFAULT_CONFIG, guard: { ...DEFAULT_CONFIG.guard, allowed_paths: [root] } };
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
  const build = { ...cfg, guard: { ...cfg.guard, profile: "build" as const, allowed_commands: [...cfg.guard.allowed_commands, "node", "npx"] } };

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
  const build = { ...cfg, guard: { ...cfg.guard, profile: "build" as const, allowed_commands: [...cfg.guard.allowed_commands, "node", "npx"] } };

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
    expect(reason(() => checkGuard("grep", ["-rf/etc/hostname", "."], root, cfg))).toBe("path_not_allowed");
    expect(reason(() => checkGuard("grep", ["-ea/b", "."], root, cfg))).toBe("path_not_allowed");
    expect(reason(() => checkGuard("grep", ["-rnA3", "-e.x", "."], root, cfg))).toBe("pass");
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

  it("pnpm, yarn 기본 정책은 조회 서브커맨드만 허용한다", () => {
    for (const [cmd, a] of [["pnpm", ["list"]], ["pnpm", ["why", "react"]], ["pnpm", ["outdated"]], ["yarn", ["info", "react"]], ["yarn", ["--version"]]] as const) {
      expect(reason(() => checkGuard(cmd, [...a], root, cfg))).toBe("pass");
    }
    for (const [cmd, a] of [["pnpm", ["run", "build"]], ["pnpm", ["dlx", "x"]], ["pnpm", ["exec", "x"]], ["yarn", []], ["yarn", ["build"]], ["yarn", ["test"]]] as const) {
      expect(reason(() => checkGuard(cmd, [...a], root, cfg))).toBe("arg_not_allowed");
    }
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

  it("입력 배열을 변경하지 않는다", () => {
    const args = ["show", "HEAD"];
    buildExecArgs("git", args);
    expect(args).toEqual(["show", "HEAD"]);
  });
});
