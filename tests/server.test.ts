import { describe, it, expect } from "vitest";
import { readFile } from "node:fs/promises";
import { buildRunResult, buildPagedResult, PACKAGE_VERSION } from "../src/server.js";
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

describe("buildRunResult() with format", () => {
  it("format=compact이면 리스트 파서 결과가 schema+rows 형식이다", async () => {
    const result = JSON.parse(
      await buildRunResult("ls", ["-la"], process.cwd(), DEFAULT_CONFIG, "compact"),
    );
    if (result.stdout.parsed && result.stdout.parsed.entries) {
      const entries = result.stdout.parsed.entries;
      expect(entries).toHaveProperty("schema");
      expect(entries).toHaveProperty("rows");
      expect(Array.isArray(entries.schema)).toBe(true);
      expect(Array.isArray(entries.rows)).toBe(true);
    }
  });

  it("format 미지정(기본값 json)이면 기존 형식 그대로다", async () => {
    const result = JSON.parse(
      await buildRunResult("echo", ["test"], process.cwd(), DEFAULT_CONFIG),
    );
    expect(result.ok).toBe(true);
    expect(result.stdout.parsed).toBeNull();
  });

  it("format=json-no-raw이면 stdout.raw가 빈 문자열이다", async () => {
    const result = JSON.parse(
      await buildRunResult("ls", ["-la"], process.cwd(), DEFAULT_CONFIG, "json-no-raw"),
    );
    expect(result.ok).toBe(true);
    expect(result.stdout.raw).toBe("");
    expect(result.stdout.parsed).not.toBeNull();
  });
});

describe("buildRunResult() native JSON passthrough", () => {
  it("stdout이 JSON이면 parsed에 파싱된 객체가 들어간다", async () => {
    const result = JSON.parse(
      await buildRunResult("echo", ['{"key":"value"}'], process.cwd(), DEFAULT_CONFIG),
    );
    expect(result.ok).toBe(true);
    expect(result.stdout.parsed).toEqual({ key: "value" });
  });

  it("stdout이 일반 텍스트이면 parsed는 null이다", async () => {
    const result = JSON.parse(
      await buildRunResult("echo", ["plain text"], process.cwd(), DEFAULT_CONFIG),
    );
    expect(result.stdout.parsed).toBeNull();
  });
});

describe("PACKAGE_VERSION", () => {
  it("package.json version과 일치한다", async () => {
    const pkgPath = new URL("../package.json", import.meta.url);
    const raw     = await readFile(pkgPath, "utf-8");
    const pkg     = JSON.parse(raw) as { version: string };

    expect(PACKAGE_VERSION).toBe(pkg.version);
  });
});
