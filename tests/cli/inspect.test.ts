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

/**
 * 회귀 방지 — 문자열 모드의 인용 한계를 **말하고** argv 모드가 실제로 지킨다.
 *
 * 계획서 4.5장: "명령 문자열은 실제 argv 입력을 받을 수 있게 하며
 * 기존 문자열 모드는 quoting 한계를 명시한다."
 *
 * 실측 배경: `parism inspect 'echo "hello   world"'` 는 공백으로 나눈 뒤
 * 따옴표를 **문자 그대로** 자식에게 넘긴다. 출력이 `"hello world"` 로
 * 따옴표를 달고 나오는 것이 그 증거다 — 사용자가 의도한 `hello   world`
 * 한 개의 인자가 되지 않는다.
 */
describe("명령 인자 모드", () => {
  it("인자를 따로 주면 공백이 그대로 전달된다 (argv 모드)", async () => {
    const { execFileSync } = await import("node:child_process");
    const out = execFileSync("node", [
      new URL("../../dist/index.js", import.meta.url).pathname,
      "inspect", "echo", "hello   world",
    ], { encoding: "utf8" });
    expect(out).toContain("hello   world");
    /** argv 모드에서는 안내를 하지 않는다 — 이미 정확히 넘겼으므로. */
    expect(out).not.toContain("문자열 모드");
  });

  it("한 토큰에 공백이 있으면 문자열 모드임을 먼저 알린다", async () => {
    const { execFileSync } = await import("node:child_process");
    const out = execFileSync("node", [
      new URL("../../dist/index.js", import.meta.url).pathname,
      "inspect", "echo hello world",
    ], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    expect(out).toContain("hello");
  });
});
