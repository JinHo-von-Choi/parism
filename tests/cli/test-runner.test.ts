import { describe, it, expect } from "vitest";
import { z }                    from "zod";
import { runFixtureTests }      from "../../src/cli/test-runner.js";

describe("runFixtureTests()", () => {
  it("fixture와 파서 결과가 일치하면 PASS를 반환한다", () => {
    const pack = {
      name:  "simple",
      parse: (raw: string) => ({ count: raw.split("\n").length }),
      schema: z.object({ count: z.number() }),
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
      name:  "mismatch",
      parse: () => ({ count: 999 }),
      schema: z.object({ count: z.number() }),
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
      name:  "throws",
      parse: () => { throw new Error("boom"); },
      schema: z.unknown(),
      fixtures: [
        { input: "x", args: [] as string[], expected: null },
      ],
    };

    const results = runFixtureTests(pack);
    expect(results.details[0].status).toBe("error");
    expect(results.details[0].error).toContain("boom");
  });

  it("fixture가 없으면 total=0이다", () => {
    const pack = { name: "empty", parse: () => null, schema: z.unknown(), fixtures: [] };
    const results = runFixtureTests(pack);
    expect(results.total).toBe(0);
  });

  it("fixture의 expected가 스키마를 위반하면 FAIL에 schema_errors.expected가 포함된다", () => {
    const pack = {
      name:  "schema-drift",
      // 파서 출력은 스키마에 맞음
      parse: () => ({ count: 42 }),
      schema: z.object({ count: z.number() }),
      fixtures: [
        // expected가 스키마 위반 (count가 string)
        { input: "x", args: [] as string[], expected: { count: "not-a-number" } },
      ],
    };

    const results = runFixtureTests(pack);
    expect(results.details[0].status).toBe("fail");
    expect(results.details[0].schema_errors?.expected).toBeDefined();
  });

  it("실제 출력이 스키마를 위반하면 FAIL에 schema_errors.actual이 포함된다", () => {
    const pack = {
      name:  "actual-violation",
      // 파서가 스키마와 다른 타입을 반환
      parse: () => ({ count: "oops" }),
      schema: z.object({ count: z.number() }),
      fixtures: [
        { input: "x", args: [] as string[], expected: { count: "oops" } },
      ],
    };

    const results = runFixtureTests(pack);
    expect(results.details[0].status).toBe("fail");
    expect(results.details[0].schema_errors?.actual).toBeDefined();
  });
});
