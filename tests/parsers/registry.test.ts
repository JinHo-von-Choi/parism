import { describe, it, expect } from "vitest";
import { ParserRegistry, type ParseContext } from "../../src/parsers/registry.js";
import type { ParserPack } from "../../src/parsers/registry.js";

describe("ParserRegistry", () => {
  it("등록된 파서가 없으면 parsed=null을 반환한다", () => {
    const registry = new ParserRegistry();
    const result   = registry.parse("unknown_cmd", [], "some output");
    expect(result.parsed).toBeNull();
    expect(result.parse_error).toBeUndefined();
  });

  it("등록된 파서가 있으면 파싱 결과를 반환한다", () => {
    const registry = new ParserRegistry();
    registry.register("echo", () => ({ words: ["hello"] }));

    const result = registry.parse("echo", ["hello"], "hello");
    expect(result.parsed).toEqual({ words: ["hello"] });
    expect(result.parse_error).toBeUndefined();
  });

  it("파서가 예외를 던지면 parsed=null, parse_error 설정 (graceful degradation)", () => {
    const registry = new ParserRegistry();
    registry.register("bad_cmd", () => { throw new Error("parse error"); });

    const result = registry.parse("bad_cmd", [], "output");
    expect(result.parsed).toBeNull();
    expect(result.parse_error).toEqual({ reason: "parser_exception", message: "parse error" });
  });

  it("defaultRegistry git status/log/diff/branch 서브커맨드 파싱", async () => {
    const { defaultRegistry } = await import("../../src/parsers/index.js");

    const statusOut = "On branch main\nChanges not staged for commit:\n  modified:   x.ts\n";
    expect(defaultRegistry.parse("git", ["status"], statusOut).parsed).not.toBeNull();

    const logOut = "abc123 feat: add\n";
    expect(defaultRegistry.parse("git", ["log", "--oneline"], logOut).parsed).not.toBeNull();

    const diffOut = "diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1,1 +1,1 @@\n-a\n+b\n";
    expect(defaultRegistry.parse("git", ["diff"], diffOut).parsed).not.toBeNull();

    const branchOut = "* main abc123 [origin/main] msg\n";
    expect(defaultRegistry.parse("git", ["branch", "-vv"], branchOut).parsed).not.toBeNull();
  });

  it("defaultRegistry git 서브커맨드 미지원 시 parsed=null", async () => {
    const { defaultRegistry } = await import("../../src/parsers/index.js");
    const result = defaultRegistry.parse("git", ["clone", "url"], "Cloning...");
    expect(result.parsed).toBeNull();
  });

  it("parse()가 ParseContext를 파서 함수에 전달한다", () => {
    const registry = new ParserRegistry();
    let   capturedCtx: ParseContext | undefined;
    registry.register("testcmd", (_cmd, _args, _raw, ctx) => { capturedCtx = ctx; return {}; });

    registry.parse("testcmd", [], "", { maxItems: 42 });
    expect(capturedCtx?.maxItems).toBe(42);
  });
});

describe("ParserPack interface", () => {
  it("ParserPack 구현체가 name, parse, schema, fixtures를 가진다", () => {
    const pack: ParserPack = {
      name: "test-cmd",
      parse: (_raw, _args) => ({ items: [] }),
      schema: {
        type: "object",
        properties: { items: { type: "array" } },
      },
      fixtures: [
        { input: "line1\nline2", args: [], expected: { items: [] } },
      ],
    };

    expect(pack.name).toBe("test-cmd");
    expect(pack.parse("", [])).toEqual({ items: [] });
    expect(pack.schema.type).toBe("object");
    expect(pack.fixtures).toHaveLength(1);
  });

  it("meta 필드는 선택적이다", () => {
    const pack: ParserPack = {
      name: "opt",
      parse: (_raw, _args) => null,
      schema: { type: "object" },
      fixtures: [],
      meta: { os: ["linux"], version: "1.0" },
    };

    expect(pack.meta?.os).toContain("linux");
  });
});
