import { describe, it, expect } from "vitest";
import { GuardError, checkGuard } from "../../src/engine/guard.js";
import { DEFAULT_CONFIG } from "../../src/config/loader.js";

describe("checkGuard()", () => {
  const cfg   = DEFAULT_CONFIG;
  const cwdOk = process.cwd();

  it("허용된 명령은 통과한다", () => {
    expect(() => checkGuard("ls", ["-la"], cwdOk, cfg)).not.toThrow();
  });

  it("허용되지 않은 명령은 GuardError를 던진다", () => {
    expect(() => checkGuard("rm", ["-rf", "/"], cwdOk, cfg))
      .toThrow(GuardError);
  });

  it("세미콜론이 포함된 인자는 차단된다", () => {
    expect(() => checkGuard("ls", ["; rm -rf /"], cwdOk, cfg))
      .toThrow(GuardError);
  });

  it("백틱이 포함된 인자는 차단된다", () => {
    expect(() => checkGuard("echo", ["`id`"], cwdOk, cfg))
      .toThrow(GuardError);
  });

  it("$( 서브쉘 패턴은 차단된다", () => {
    expect(() => checkGuard("echo", ["$(cat /etc/passwd)"], cwdOk, cfg))
      .toThrow(GuardError);
  });

  it("허용된 경로 내의 cwd는 통과한다", () => {
    const cfg2 = { ...cfg, guard: { ...cfg.guard, allowed_paths: ["/home"] } };
    expect(() => checkGuard("ls", [], "/home/user/project", cfg2)).not.toThrow();
  });

  it("허용된 경로 외의 cwd는 차단된다", () => {
    const cfg2 = { ...cfg, guard: { ...cfg.guard, allowed_paths: ["/home/user"] } };
    expect(() => checkGuard("ls", [], "/etc", cfg2))
      .toThrow(GuardError);
  });

  it("../ 경로 순회로 allowed_paths 우회를 차단한다", () => {
    const cfg2 = { ...cfg, guard: { ...cfg.guard, allowed_paths: ["/home/user"] } };
    expect(() => checkGuard("ls", [], "/home/user/../../etc", cfg2))
      .toThrow(GuardError);
  });

  it("허용 경로 밖 절대경로 인자를 차단한다", () => {
    const cfg2 = { ...cfg, guard: { ...cfg.guard, allowed_paths: ["/home/user"] } };
    expect(() => checkGuard("cat", ["/etc/passwd"], "/home/user/project", cfg2))
      .toThrow(GuardError);
  });

  it("허용 경로 밖 상대경로 인자(find src, cat subdir/file)를 차단한다", () => {
    const cfg2 = { ...cfg, guard: { ...cfg.guard, allowed_paths: ["/home/user/project"] } };
    expect(() => checkGuard("find", [".."], "/home/user/project", cfg2))
      .toThrow(GuardError);
    expect(() => checkGuard("cat", ["../etc/passwd"], "/home/user/project", cfg2))
      .toThrow(GuardError);
  });

  it("node -e는 arg_not_allowed로 차단된다", () => {
    const cfg2 = {
      ...cfg,
      guard: {
        ...cfg.guard,
        command_arg_restrictions: {
          node: { blocked_flags: ["-e", "--eval"] },
        },
      },
    };
    expect(() => checkGuard("node", ["-e", "require('fs').readFileSync('/etc/passwd')"], cwdOk, cfg2))
      .toThrow(GuardError);
  });

  it("node --eval=code 형태도 차단된다", () => {
    const cfg2 = {
      ...cfg,
      guard: {
        ...cfg.guard,
        command_arg_restrictions: {
          node: { blocked_flags: ["-e", "--eval"] },
        },
      },
    };
    expect(() => checkGuard("node", ["--eval=console.log(1)"], cwdOk, cfg2))
      .toThrow(GuardError);
  });

  it("npx --yes는 차단된다", () => {
    const cfg2 = {
      ...cfg,
      guard: {
        ...cfg.guard,
        command_arg_restrictions: {
          npx: { blocked_flags: ["--yes", "-y"] },
        },
      },
    };
    expect(() => checkGuard("npx", ["--yes", "cowsay", "hello"], cwdOk, cfg2))
      .toThrow(GuardError);
  });

  it("curl -d는 arg_not_allowed로 차단된다", () => {
    expect(() => checkGuard("curl", ["-d", "foo=bar", "https://example.com"], cwdOk, cfg))
      .toThrow(GuardError);
  });

  it("curl -I는 통과한다", () => {
    expect(() => checkGuard("curl", ["-I", "https://example.com"], cwdOk, cfg)).not.toThrow();
  });

  it("kill은 기본 허용 목록에 없어 차단된다", () => {
    expect(() => checkGuard("kill", ["-9", "12345"], cwdOk, cfg)).toThrow(GuardError);
  });

  it("제한 없는 명령의 정상 인자는 통과한다", () => {
    const cfg2 = {
      ...cfg,
      guard: {
        ...cfg.guard,
        allowed_commands: [...cfg.guard.allowed_commands, "node"],
        command_arg_restrictions: {
          node: { blocked_flags: ["-e", "--eval"] },
        },
      },
    };
    expect(() => checkGuard("node", ["--version"], cwdOk, cfg2)).not.toThrow();
  });
});
