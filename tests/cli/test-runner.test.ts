import { describe, it, expect } from "vitest";
import { runFixtureTests } from "../../src/cli/test-runner.js";

describe("runFixtureTests()", () => {
  it("fixture와 파서 결과가 일치하면 PASS를 반환한다", () => {
    const pack = {
      name: "simple",
      parse: (raw: string) => ({ count: raw.split("\n").length }),
      schema: {},
      fixtures: [
        { input: "a\nb\nc", args: [] as string[], expected: { count: 3 } },
      ],
    };

    const results = runFixtureTests(pack);
    expect(results.total).toBe(1);
    expect(results.passed).toBe(1);
    expect(results.failed).toBe(0);
    expect(results.details[0].status).toBe("pass");
  });

  it("fixture와 파서 결과가 불일치하면 FAIL을 반환한다", () => {
    const pack = {
      name: "mismatch",
      parse: () => ({ count: 999 }),
      schema: {},
      fixtures: [
        { input: "a\nb", args: [] as string[], expected: { count: 2 } },
      ],
    };

    const results = runFixtureTests(pack);
    expect(results.total).toBe(1);
    expect(results.passed).toBe(0);
    expect(results.failed).toBe(1);
    expect(results.details[0].status).toBe("fail");
  });

  it("파서가 예외를 던지면 ERROR를 반환한다", () => {
    const pack = {
      name: "throws",
      parse: () => { throw new Error("boom"); },
      schema: {},
      fixtures: [
        { input: "x", args: [] as string[], expected: null },
      ],
    };

    const results = runFixtureTests(pack);
    expect(results.details[0].status).toBe("error");
    expect(results.details[0].error).toContain("boom");
  });

  it("fixture가 없으면 total=0이다", () => {
    const pack = { name: "empty", parse: () => null, schema: {}, fixtures: [] };
    const results = runFixtureTests(pack);
    expect(results.total).toBe(0);
  });
});
