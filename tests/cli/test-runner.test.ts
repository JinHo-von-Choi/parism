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

  /**
   * 회귀 방지 — 비교가 **구조적**인가.
   *
   * 계획서 4.5장: "JSON.stringify 의 키 순서 의존 비교를 구조적 비교로 바꾼다."
   * 예전 비교(`JSON.stringify(actual) === JSON.stringify(expected)`)는 파서가 객체 키
   * 순서만 바꿔도 실패로 fell 했다. 키 순서는 계약이 아니다.
   * 배열 순서는 값이므로 여전히 변화로 본다 — 그 구분이 이 수정의 전부다.
   */
  it("객체 키 순서만 달라도 통과한다 (구조적 비교)", () => {
    const pack = {
      name:  "order",
      parse: () => ({ b: 2, a: 1 }),
      schema: z.object({ a: z.number(), b: z.number() }),
      fixtures: [{ input: "x", args: [] as string[], expected: { a: 1, b: 2 } }],
    };
    const r = runFixtureTests(pack);
    expect(r.failed).toBe(0);
    expect(r.details[0].status).toBe("pass");
  });

  it("배열 순서가 다르면 실패한다 (순서는 값이다)", () => {
    const pack = {
      name:  "seq",
      parse: () => ({ xs: [1, 2] }),
      schema: z.object({ xs: z.array(z.number()) }),
      fixtures: [{ input: "x", args: [] as string[], expected: { xs: [2, 1] } }],
    };
    expect(runFixtureTests(pack).failed).toBe(1);
  });

  it("실패하면 어디가 달라졌는지 경로를 남긴다", () => {
    const pack = {
      name:  "where",
      parse: () => ({ rows: [{ name: "a", size: 1 }] }),
      schema: z.object({ rows: z.array(z.object({ name: z.string(), size: z.number() })) }),
      fixtures: [{ input: "x", args: [] as string[], expected: { rows: [{ name: "a", size: 2 }] } }],
    };
    const d = runFixtureTests(pack).details[0];
    expect(d.status).toBe("fail");
    expect(d.changes?.length).toBeGreaterThan(0);
    expect(d.changes?.some(c => c.path === "/rows/0/size")).toBe(true);
  });
});
