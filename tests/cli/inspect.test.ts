import { describe, it, expect } from "vitest";
import { inspectOutput }       from "../../src/cli/inspect.js";
import { ParserRegistry }      from "../../src/parsers/registry.js";

describe("inspectOutput", () => {
  it("raw, parsed, compact 모두 반환 -- 파서 등록 시", () => {
    const registry = new ParserRegistry();
    registry.register("echo", (_cmd, _args, raw) => ({ lines: [raw.trim()] }));

    const result = inspectOutput("echo", ["hello"], "hello\n", registry);

    expect(result.raw).toBe("hello\n");
    expect(result.parsed).toEqual({ lines: ["hello"] });
    expect(result.compact).not.toBeNull();
  });

  it("parsed=null, compact=null -- 파서 미등록 시", () => {
    const registry = new ParserRegistry();

    const result = inspectOutput("unknown-cmd", [], "some output\n", registry);

    expect(result.raw).toBe("some output\n");
    expect(result.parsed).toBeNull();
    expect(result.compact).toBeNull();
  });

  it("tokens 객체에 raw, parsed, compact 숫자가 포함된다", () => {
    const registry = new ParserRegistry();
    registry.register("ls", (_cmd, _args, raw) => {
      return { files: raw.trim().split("\n") };
    });

    const result = inspectOutput("ls", [], "file1\nfile2\nfile3\n", registry);

    expect(result.tokens.raw).toBeGreaterThan(0);
    expect(result.tokens.parsed).toBeGreaterThan(0);
    expect(result.tokens.compact).toBeGreaterThan(0);
    expect(typeof result.tokens.raw).toBe("number");
    expect(typeof result.tokens.parsed).toBe("number");
    expect(typeof result.tokens.compact).toBe("number");
  });

  it("compact 토큰이 parsed 토큰보다 작거나 같다 -- 충분한 행 수에서 토큰 절감", () => {
    const registry = new ParserRegistry();
    const rows     = Array.from({ length: 20 }, (_, i) => ({
      pid: String(i + 1), name: `process-${i + 1}`, cpu: "0.0", mem: "1.2",
    }));
    registry.register("ps", (_cmd, _args, _raw) => ({ processes: rows }));

    const rawLines = rows.map(r => `${r.pid}  ${r.name}  ${r.cpu}  ${r.mem}`).join("\n") + "\n";
    const result   = inspectOutput("ps", ["aux"], rawLines, registry);

    expect(result.tokens.compact).toBeLessThanOrEqual(result.tokens.parsed);
  });
});
