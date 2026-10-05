/**
 * describe(cmd) 명령별 능력 조회 시험.
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 */

import { describe, it, expect } from "vitest";
import { ParismEngine, type CommandDescription } from "../../src/facade/engine.js";
import { ALTERNATIVE_SAMPLES, COMMAND_EXAMPLES } from "../../src/facade/capabilities.js";
import { DEFAULT_CONFIG, type PrismConfig }      from "../../src/config/loader.js";
import { createRegistry }                        from "../../src/parsers/index.js";
import { BUILTIN_CONTRACTS }                     from "../../src/parsers/contracts.js";

const registry = createRegistry();

function engineWith(patch: (c: PrismConfig) => void = () => {}): ParismEngine {
  const config = structuredClone(DEFAULT_CONFIG);
  config.guard.allowed_paths = [process.cwd()];
  patch(config);
  return new ParismEngine(config, registry);
}

/** 공백으로 이은 이름 목록을 낱말로 나눈다. */
function words(list: string | undefined): string[] {
  return list === undefined || list === "" ? [] : list.split(" ");
}

function described(engine: ParismEngine, cmd: string): CommandDescription {
  const result = engine.describe(cmd);
  if ("failure" in result) throw new Error(result.failure.message);
  return result;
}

describe("describe(cmd) 기본 명령", () => {
  const readonly = engineWith();
  const build    = engineWith(c => { c.guard.profile = "build"; });

  it.each(DEFAULT_CONFIG.guard.allowed_commands)("%s 응답은 2KB 이하다", (cmd) => {
    for (const engine of [readonly, build]) {
      const result = described(engine, cmd);
      expect(result.cmd).toBe(cmd);
      expect(Buffer.byteLength(JSON.stringify(result), "utf8")).toBeLessThanOrEqual(2048);
    }
  });

  it("기본 명령 40종 모두 예시가 있고 예시는 현재 정책을 통과한다", () => {
    expect(DEFAULT_CONFIG.guard.allowed_commands).toHaveLength(40);
    for (const cmd of DEFAULT_CONFIG.guard.allowed_commands) {
      const result = described(readonly, cmd);
      expect(result.examples.length, cmd).toBeGreaterThan(0);
      for (const args of result.examples) expect(readonly.dryRun(cmd, args).would_pass, `${cmd} ${args.join(" ")}`).toBe(true);
    }
  });

  it("예시 표의 항목은 정책을 통과하지 못하면 응답에서 빠진다", () => {
    const listed = COMMAND_EXAMPLES.npm!.length;
    expect(described(readonly, "npm").examples.length).toBeLessThan(listed);
    expect(described(build, "npm").examples.length).toBe(listed);
  });

  it("대체 형식 표본은 모두 형식 안내를 낸다", () => {
    for (const [cmd, samples] of Object.entries(ALTERNATIVE_SAMPLES)) {
      const result = described(readonly, cmd);
      expect(result.alternatives.map(a => a.from), cmd).toEqual(samples);
    }
  });
});

describe("describe(cmd) 내용", () => {
  const engine = engineWith();

  it("ls: 정책, 파서 형식, 대체 형식을 함께 돌려준다", () => {
    const result = described(engine, "ls");
    expect(result.profile).toBe("readonly");
    expect(result.policy.origin).toBe("default");
    expect(result.policy.positionals).toBe("path");
    expect(words(result.policy.flags)).toContain("-l");
    expect(words(result.parser?.flags)).toContain("--full-time");
    expect(words(result.parser?.flags)).not.toContain("-l");
    expect(words(result.parser?.requires)).toContain("-l");
    expect(result.parser?.values?.["--format"]).toBe("^(long|verbose)$");
    expect(result.parser?.rows_key).toBe("entries");
    expect(words(result.parser?.row_fields)).toContain("size_bytes");
    expect(result.alternatives[0]).toMatchObject({ from: [], args: ["-l"] });
    expect(result.alternatives[0]!.reason).toContain("-l");
  });

  it("git: 서브커맨드별 파서 형식과 정책의 서브커맨드", () => {
    const result = described(engine, "git");
    expect(words(result.policy.subcommands)).toContain("status");
    expect(Object.keys(result.parser?.subcommands ?? {})).toEqual(["status", "log", "branch", "diff"]);
    expect(result.parser?.subcommands?.log?.rows_key).toBe("commits");
    expect(result.parser?.leading_flags).toBeUndefined();
  });

  it("파서가 받겠다고 안내한 플래그는 guard도 통과시킨다", () => {
    /**
     * describe 가 안내한 인자를 따라갔다가 guard 에 막히면, 안내가 거짓말이 된다.
     * 파서 계약과 guard 정책이 어긋나지 않는지 서브커맨드별로 확인한다.
     */
    const status = described(engine, "git").parser?.subcommands?.status;
    expect(words(status?.flags)).toContain("-b");

    /**
     * 이번에 손댄 git status 계약만 판정한다.
     * 다른 명령에도 파서 계약과 guard 정책이 어긋난 곳이 남아 있다(예: kubectl get pods 의 -n).
     * 그건 M1 범위를 넘어서는 일이라 여기서 넓게 단정하지 않고, 발견 사실로 따로 남긴다.
     */
    const readonly   = engineWith();
    const statusArgs = BUILTIN_CONTRACTS.git!.subcommands!.status!;
    for (const [flag, arity] of Object.entries(statusArgs.acceptedFlags ?? {})) {
      const probe = arity === "value" ? ["status", flag, "1"] : ["status", flag];
      expect(readonly.dryRun("git", probe, process.cwd()).would_pass, probe.join(" ")).toBe(true);
    }
  });

  it("인자 형식 제한이 없는 파서는 any_args로 알린다", () => {
    expect(described(engine, "cat").parser).toEqual({ any_args: true });
  });

  it("파서가 없는 명령은 parser가 null이다", () => {
    expect(described(engine, "echo").parser).toBeNull();
  });

  it("build 프로필과 설정 정책의 출처를 구분한다", () => {
    const build  = engineWith(c => { c.guard.profile = "build"; });
    const custom = engineWith(c => { c.guard.command_policies = { ls: { flags: { "-l": "bool" }, positionals: "path" } }; });
    expect(described(build, "npm").policy.origin).toBe("build");
    expect(words(described(build, "npm").policy.subcommands)).toContain("test");
    expect(described(custom, "ls").policy).toMatchObject({ origin: "config", flags: "-l" });
    expect(described(custom, "ls").parser?.flags).toBe("");
  });

  it("정책 없이 허용된 명령은 origin=none이고 막힌 플래그를 보여 준다", () => {
    const engine2 = engineWith(c => {
      c.guard.allowed_commands = [...c.guard.allowed_commands, "make"];
      c.guard.command_arg_restrictions = { ...c.guard.command_arg_restrictions, make: { blocked_flags: ["-f"] } };
    });
    const result = described(engine2, "make");
    expect(result.policy).toEqual({ origin: "none", blocked_flags: "-f" });
    expect(result.examples).toEqual([]);
  });

  it("허용되지 않은 명령은 예외 없이 failure를 돌려준다", () => {
    for (const cmd of ["rm", "__proto__", "constructor", ""]) {
      const result = engine.describe(cmd);
      expect("failure" in result, cmd).toBe(true);
      if ("failure" in result) {
        expect(result.failure.kind).toBe("guard");
        expect(result.failure.reason).toBe("command_not_allowed");
        expect(result.failure.message).toContain("describe");
      }
    }
  });

  it("cmd가 없으면 기존 전체 요약을 돌려준다", () => {
    const result = engine.describe();
    expect(result.allowed_commands).toContain("ls");
    expect(result.guard_summary.profile).toBe("readonly");
  });
});
