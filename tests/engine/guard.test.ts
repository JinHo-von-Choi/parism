import { describe, it, expect } from "vitest";
import { GuardError, checkGuard } from "../../src/engine/guard.js";
import { DEFAULT_CONFIG } from "../../src/config/loader.js";

describe("checkGuard()", () => {
  const cfg = DEFAULT_CONFIG;

  it("허용된 명령은 통과한다", () => {
    expect(() => checkGuard("ls", ["-la"], "/tmp", cfg)).not.toThrow();
  });

  it("허용되지 않은 명령은 GuardError를 던진다", () => {
    expect(() => checkGuard("rm", ["-rf", "/"], "/tmp", cfg))
      .toThrow(GuardError);
  });

  it("세미콜론이 포함된 인자는 차단된다", () => {
    expect(() => checkGuard("ls", ["; rm -rf /"], "/tmp", cfg))
      .toThrow(GuardError);
  });

  it("백틱이 포함된 인자는 차단된다", () => {
    expect(() => checkGuard("echo", ["`id`"], "/tmp", cfg))
      .toThrow(GuardError);
  });

  it("$( 서브쉘 패턴은 차단된다", () => {
    expect(() => checkGuard("echo", ["$(cat /etc/passwd)"], "/tmp", cfg))
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
    expect(() => checkGuard("node", ["-e", "require('fs').readFileSync('/etc/passwd')"], "/tmp", cfg2))
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
    expect(() => checkGuard("node", ["--eval=console.log(1)"], "/tmp", cfg2))
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
    expect(() => checkGuard("npx", ["--yes", "cowsay", "hello"], "/tmp", cfg2))
      .toThrow(GuardError);
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
    expect(() => checkGuard("node", ["--version"], "/tmp", cfg2)).not.toThrow();
  });
});
