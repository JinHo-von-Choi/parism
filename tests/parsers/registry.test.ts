import { describe, it, expect } from "vitest";
import { ParserRegistry, type ParseContext } from "../../src/parsers/registry.js";

describe("ParserRegistry", () => {
  it("등록된 파서가 없으면 null을 반환한다", () => {
    const registry = new ParserRegistry();
    const result   = registry.parse("unknown_cmd", [], "some output");
    expect(result).toBeNull();
  });

  it("등록된 파서가 있으면 파싱 결과를 반환한다", () => {
    const registry = new ParserRegistry();
    registry.register("echo", () => ({ words: ["hello"] }));

    const result = registry.parse("echo", ["hello"], "hello");
    expect(result).toEqual({ words: ["hello"] });
  });

  it("파서가 예외를 던지면 null을 반환한다 (graceful degradation)", () => {
    const registry = new ParserRegistry();
    registry.register("bad_cmd", () => { throw new Error("parse error"); });

    const result = registry.parse("bad_cmd", [], "output");
    expect(result).toBeNull();
  });

  it("parse()가 ParseContext를 파서 함수에 전달한다", () => {
    const registry = new ParserRegistry();
    let   capturedCtx: ParseContext | undefined;
    registry.register("testcmd", (_cmd, _args, _raw, ctx) => { capturedCtx = ctx; return {}; });

    registry.parse("testcmd", [], "", { maxItems: 42 });
    expect(capturedCtx?.maxItems).toBe(42);
  });
});
