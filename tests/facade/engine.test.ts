import { describe, it, expect } from "vitest";
import { ParismEngine, createEngine } from "../../src/facade/engine.js";
import { DEFAULT_CONFIG }             from "../../src/config/loader.js";
import { createRegistry }             from "../../src/parsers/index.js";

describe("createEngine()", () => {
  it("기본 설정으로 ParismEngine 인스턴스를 반환한다", async () => {
    const engine = await createEngine();
    expect(engine).toBeInstanceOf(ParismEngine);
  });
});

describe("ParismEngine.run()", () => {
  const registry = createRegistry();
  const engine   = new ParismEngine(DEFAULT_CONFIG, registry);

  it("echo 명령이 성공 봉투를 반환한다", async () => {
    const result = await engine.run("echo", { args: ["hello"] });

    expect(result.ok).toBe(true);
    expect(result.stdout.raw.trim()).toBe("hello");
  });

  it("차단된 명령은 failure.kind=guard를 반환한다", async () => {
    const result = await engine.run("rm", { args: ["-rf", "/"] });

    expect(result.ok).toBe(false);
    expect(result.failure?.kind).toBe("guard");
    expect(result.failure?.reason).toBe("command_not_allowed");
  });

  it("차단된 명령 봉투에 guard_error 필드가 존재한다", async () => {
    const result = await engine.run("rm", { args: ["-rf", "/"] });

    expect(result.guard_error).toBeDefined();
    expect(result.guard_error?.reason).toBe("command_not_allowed");
  });

  it("파서 미등록 명령은 ok=true이고 failure.reason=parser_not_found를 반환한다", async () => {
    const result = await engine.run("echo", { args: ["plain text"] });

    expect(result.ok).toBe(true);
    expect(result.failure?.kind).toBe("parse");
    expect(result.failure?.reason).toBe("parser_not_found");
  });
});

describe("ParismEngine.runPaged()", () => {
  const registry = createRegistry();
  const engine   = new ParismEngine(DEFAULT_CONFIG, registry);

  it("page_size 이내의 출력은 has_next=false를 반환한다", async () => {
    const result = await engine.runPaged("echo", { args: ["hello"], page_size: 5 });

    expect(result.ok).toBe(true);
    expect(result.page_info).toBeDefined();
    expect(result.page_info?.has_next).toBe(false);
    expect(result.page_info?.total_lines).toBe(1);
  });

  it("stdout.parsed는 항상 null이다", async () => {
    const result = await engine.runPaged("echo", { args: ["hello"] });

    expect(result.stdout.parsed).toBeNull();
  });

  it("page_size로 출력을 분할한다", async () => {
    // echo는 줄이 하나뿐이지만 page=1에서 빈 페이지를 반환한다
    const result = await engine.runPaged("echo", { args: ["hello"], page: 1, page_size: 1 });

    expect(result.ok).toBe(true);
    expect(result.page_info?.page).toBe(1);
    expect(result.stdout.raw).toBe("");
  });

  it("차단된 명령은 failure.kind=guard를 반환한다", async () => {
    const result = await engine.runPaged("rm", { args: ["-rf", "/"] });

    expect(result.ok).toBe(false);
    expect(result.failure?.kind).toBe("guard");
  });
});

/* ─── describe() ─── */
describe("ParismEngine.describe()", () => {
  const registry = createRegistry();
  const engine   = new ParismEngine(DEFAULT_CONFIG, registry);

  it("version, allowed_commands, available_parsers를 반환한다", () => {
    const desc = engine.describe();

    expect(desc.version).toBeDefined();
    expect(Array.isArray(desc.allowed_commands)).toBe(true);
    expect(desc.allowed_commands.length).toBeGreaterThan(0);
    expect(Array.isArray(desc.available_parsers)).toBe(true);
  });

  it("guard_summary에 block_patterns과 timeout_ms가 포함된다", () => {
    const desc = engine.describe();

    expect(desc.guard_summary.block_patterns).toEqual(DEFAULT_CONFIG.guard.block_patterns);
    expect(desc.guard_summary.timeout_ms).toBe(DEFAULT_CONFIG.guard.timeout_ms);
    expect(desc.guard_summary.max_output_bytes).toBe(DEFAULT_CONFIG.guard.max_output_bytes);
  });

  it("command_arg_restrictions가 원본과 동일한 구조를 갖는다", () => {
    const desc = engine.describe();
    const keys = Object.keys(desc.guard_summary.command_arg_restrictions);

    expect(keys).toContain("node");
    expect(keys).toContain("curl");
    expect(desc.guard_summary.command_arg_restrictions["node"].blocked_flags).toContain("-e");
  });

  it("telemetry_enabled가 기본 비활성이다", () => {
    const desc = engine.describe();
    expect(desc.telemetry_enabled).toBe(false);
  });
});

/* ─── dryRun() ─── */
describe("ParismEngine.dryRun()", () => {
  const registry = createRegistry();
  const engine   = new ParismEngine(DEFAULT_CONFIG, registry);

  it("허용된 명령은 would_pass=true를 반환한다", () => {
    const result = engine.dryRun("echo", ["hello"]);

    expect(result.would_pass).toBe(true);
    expect(result.reason).toBeUndefined();
    expect(result.message).toBeUndefined();
  });

  it("차단된 명령은 would_pass=false와 reason을 반환한다", () => {
    const result = engine.dryRun("rm", ["-rf", "/"]);

    expect(result.would_pass).toBe(false);
    expect(result.reason).toBe("command_not_allowed");
    expect(result.message).toBeDefined();
  });

  it("injection 패턴은 would_pass=false, reason=injection_pattern을 반환한다", () => {
    const result = engine.dryRun("echo", ["hello;rm -rf /"]);

    expect(result.would_pass).toBe(false);
    expect(result.reason).toBe("injection_pattern");
  });

  it("차단된 플래그는 would_pass=false, reason=arg_not_allowed를 반환한다", () => {
    const result = engine.dryRun("curl", ["-d", "payload", "http://example.com"]);

    expect(result.would_pass).toBe(false);
    expect(result.reason).toBe("arg_not_allowed");
  });
});

/* ─── Telemetry ─── */
describe("ParismEngine.run() — telemetry", () => {
  const registry = createRegistry();

  it("telemetry 비활성 시 telemetry 필드가 없다", async () => {
    const engine = new ParismEngine(DEFAULT_CONFIG, registry);
    const result = await engine.run("echo", { args: ["hi"] });

    expect(result.telemetry).toBeUndefined();
  });

  it("telemetry 활성 시 단계별 타이밍이 포함된다", async () => {
    const config = {
      ...DEFAULT_CONFIG,
      telemetry: { enabled: true },
    };
    const engine = new ParismEngine(config, registry);
    const result = await engine.run("echo", { args: ["hello"] });

    expect(result.telemetry).toBeDefined();
    const t = result.telemetry!;
    expect(typeof t.guard_ms).toBe("number");
    expect(typeof t.exec_ms).toBe("number");
    expect(typeof t.parse_ms).toBe("number");
    expect(typeof t.redact_ms).toBe("number");
    expect(typeof t.total_ms).toBe("number");
    expect(typeof t.raw_bytes).toBe("number");
    expect(t.total_ms).toBeGreaterThanOrEqual(0);
    expect(t.raw_bytes).toBeGreaterThan(0);
  });

  it("telemetry total_ms >= guard_ms + exec_ms 이상이다", async () => {
    const config = {
      ...DEFAULT_CONFIG,
      telemetry: { enabled: true },
    };
    const engine = new ParismEngine(config, registry);
    const result = await engine.run("echo", { args: ["timing test"] });

    const t = result.telemetry!;
    expect(t.total_ms).toBeGreaterThanOrEqual(t.guard_ms);
  });
});
