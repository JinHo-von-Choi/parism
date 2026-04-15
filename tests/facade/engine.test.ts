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
