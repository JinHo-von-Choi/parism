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
    // failure.kind="guard", failure.reason=GuardError.reason 매핑 검증
    try { checkGuard("rm", ["-rf", "/"], cwdOk, cfg); } catch (e) {
      expect(e).toBeInstanceOf(GuardError);
      expect((e as GuardError).reason).toBe("command_not_allowed");
    }
  });

  it("세미콜론이 포함된 인자는 차단된다", () => {
    expect(() => checkGuard("ls", ["; rm -rf /"], cwdOk, cfg))
      .toThrow(GuardError);
    try { checkGuard("ls", ["; rm -rf /"], cwdOk, cfg); } catch (e) {
      expect(e).toBeInstanceOf(GuardError);
      expect((e as GuardError).reason).toBe("injection_pattern");
    }
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
    // failure.kind="guard", failure.reason="path_not_allowed" 매핑 검증
    try { checkGuard("ls", [], "/etc", cfg2); } catch (e) {
      expect((e as GuardError).reason).toBe("path_not_allowed");
    }
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
        allowed_commands: [...cfg.guard.allowed_commands, "node"],
        command_arg_restrictions: {
          node: { blocked_flags: ["-e", "--eval"] },
        },
      },
    };
    expect(() => checkGuard("node", ["-e", "require('fs').readFileSync('/etc/passwd')"], cwdOk, cfg2))
      .toThrow(GuardError);
    // failure.kind="guard", failure.reason="arg_not_allowed" 매핑 검증
    try { checkGuard("node", ["-e", "require('fs').readFileSync('/etc/passwd')"], cwdOk, cfg2); } catch (e) {
      expect((e as GuardError).reason).toBe("arg_not_allowed");
    }
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

  it("인자 경계에서 합성되는 패턴은 오탐하지 않는다", () => {
    // ["foo>", "bar"] 를 join하면 "foo> bar" — >> 패턴이 아님
    // 개별 인자에도 >> 없으므로 통과해야 함
    const cfg2 = {
      ...cfg,
      guard: {
        ...cfg.guard,
        block_patterns: [">>"],
      },
    };
    expect(() => checkGuard("echo", ["foo>", ">bar"], cwdOk, cfg2)).not.toThrow();
  });

  it("개별 인자 내 injection 패턴은 여전히 차단된다", () => {
    expect(() => checkGuard("echo", ["hello>>world"], cwdOk, {
      ...cfg,
      guard: { ...cfg.guard, block_patterns: [">>"] },
    })).toThrow(GuardError);
  });

  it("injection 에러 메시지에 문제 인자가 명시된다", () => {
    try {
      checkGuard("echo", ["safe", "bad;arg"], cwdOk, cfg);
    } catch (e) {
      expect(e).toBeInstanceOf(GuardError);
      expect((e as GuardError).message).toContain("bad;arg");
    }
  });

  it("git add로 허용 경로 밖 파일 접근이 차단된다", () => {
    const cfg2 = {
      ...cfg,
      guard: {
        ...cfg.guard,
        allowed_commands: [...cfg.guard.allowed_commands, "git"],
        allowed_paths: ["/home/user/project"],
      },
    };
    expect(() => checkGuard("git", ["add", "/etc/passwd"], "/home/user/project", cfg2))
      .toThrow(GuardError);
    try {
      checkGuard("git", ["add", "/etc/passwd"], "/home/user/project", cfg2);
    } catch (e) {
      expect((e as GuardError).reason).toBe("path_not_allowed");
    }
  });

  it("docker build로 허용 경로 밖 접근이 차단된다", () => {
    const cfg2 = {
      ...cfg,
      guard: {
        ...cfg.guard,
        allowed_commands: [...cfg.guard.allowed_commands, "docker"],
        allowed_paths: ["/home/user/project"],
      },
    };
    expect(() => checkGuard("docker", ["build", "/tmp/outside"], "/home/user/project", cfg2))
      .toThrow(GuardError);
  });

  it("git status (경로 인자 없음)는 정상 통과한다", () => {
    const cfg2 = {
      ...cfg,
      guard: {
        ...cfg.guard,
        allowed_commands: [...cfg.guard.allowed_commands, "git"],
        allowed_paths: ["/home/user/project"],
      },
    };
    expect(() => checkGuard("git", ["status"], "/home/user/project", cfg2)).not.toThrow();
  });
});
