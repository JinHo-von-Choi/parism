import { describe, it, expect } from "vitest";
import { buildRunResult, buildPagedResult } from "../src/server.js";
import { DEFAULT_CONFIG } from "../src/config/loader.js";

describe("buildRunResult()", () => {
  it("echo 명령을 실행하고 JSON 문자열을 반환한다", async () => {
    const result = await buildRunResult("echo", ["test-output"], process.cwd(), DEFAULT_CONFIG);
    const parsed = JSON.parse(result);

    expect(parsed.ok).toBe(true);
    expect(parsed.stdout.raw.trim()).toBe("test-output");
  });

  it("차단된 명령은 ok=false와 guard_error를 반환한다", async () => {
    const result = await buildRunResult("rm", ["-rf", "/"], process.cwd(), DEFAULT_CONFIG);
    const parsed = JSON.parse(result);

    expect(parsed.ok).toBe(false);
    expect(parsed.guard_error).toBeDefined();
    expect(parsed.guard_error.reason).toBe("command_not_allowed");
  });
});

describe("buildPagedResult()", () => {
  it("run_paged 도구가 page_info를 포함한 응답을 반환한다", async () => {
    const result = JSON.parse(
      await buildPagedResult("echo", ["hello"], process.cwd(), 0, 5, DEFAULT_CONFIG),
    );
    // echo는 단일 줄 출력이므로 total_lines=1, has_next=false
    expect(result.page_info).toBeDefined();
    expect(result.page_info.has_next).toBe(false);
    expect(result.page_info.total_lines).toBe(1);
    expect(result.ok).toBe(true);
  });

  it("차단된 명령은 ok=false와 guard_error를 반환한다", async () => {
    const result = JSON.parse(
      await buildPagedResult("rm", ["-rf", "/"], process.cwd(), 0, 5, DEFAULT_CONFIG),
    );
    expect(result.ok).toBe(false);
    expect(result.guard_error).toBeDefined();
  });

  it("stdout.parsed는 항상 null이다", async () => {
    const result = JSON.parse(
      await buildPagedResult("echo", ["hello"], process.cwd(), 0, 5, DEFAULT_CONFIG),
    );
    expect(result.stdout.parsed).toBeNull();
  });
});
