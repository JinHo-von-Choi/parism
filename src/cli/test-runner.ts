import type { ParserPack } from "../parsers/registry.js";

export interface FixtureTestDetail {
  index:    number;
  status:   "pass" | "fail" | "error";
  expected: unknown;
  actual?:  unknown;
  error?:   string;
  /** schema_violation が発생した時のメッセージ (expected または actual) */
  schema_errors?: {
    expected?: string;
    actual?:   string;
  };
}

export interface FixtureTestResults {
  name:    string;
  total:   number;
  passed:  number;
  failed:  number;
  errored: number;
  details: FixtureTestDetail[];
}

/**
 * ParserPack의 fixture를 순회하며 replay 테스트를 실행한다.
 *
 * 검증 순서 (모두 ALWAYS 실행 — strict_schemas 설정과 무관):
 *  1. pack.schema.safeParse(fixture.expected) — 저장된 기댓값이 현재 스키마를 만족하는지 확인 (드리프트 감지)
 *  2. 파서 실행 후 pack.schema.safeParse(actual) — 실제 출력이 스키마를 만족하는지 확인
 *  3. JSON.stringify 동등성 검사 (기존 동작 유지)
 *
 * 1 또는 2에서 schema_violation이 발생하면 상태를 "fail"로 설정하고 schema_errors에 메시지를 기록한다.
 * 3의 불일치도 독립적으로 "fail"을 유발한다.
 */
export function runFixtureTests(pack: ParserPack): FixtureTestResults {
  const details: FixtureTestDetail[] = [];

  for (let i = 0; i < pack.fixtures.length; i++) {
    const fixture = pack.fixtures[i];

    // 1. 기댓값 스키마 검증 (드리프트 감지)
    const expectedSchemaResult = pack.schema.safeParse(fixture.expected);
    const expectedSchemaError  = expectedSchemaResult.success
      ? undefined
      : expectedSchemaResult.error.issues
          .map(iss => `${iss.path.length > 0 ? iss.path.join(".") + ": " : ""}${iss.message}`)
          .join("; ");

    try {
      const actual = pack.parse(fixture.input, fixture.args);

      // 2. 실제 출력 스키마 검증
      const actualSchemaResult = pack.schema.safeParse(actual);
      const actualSchemaError  = actualSchemaResult.success
        ? undefined
        : actualSchemaResult.error.issues
            .map(iss => `${iss.path.length > 0 ? iss.path.join(".") + ": " : ""}${iss.message}`)
            .join("; ");

      // 3. 동등성 검사
      const match = JSON.stringify(actual) === JSON.stringify(fixture.expected);

      const hasSchemaError = expectedSchemaError !== undefined || actualSchemaError !== undefined;
      const status         = (match && !hasSchemaError) ? "pass" : "fail";

      const detail: FixtureTestDetail = {
        index:    i,
        status,
        expected: fixture.expected,
        actual,
      };

      if (hasSchemaError) {
        detail.schema_errors = {};
        if (expectedSchemaError) detail.schema_errors.expected = expectedSchemaError;
        if (actualSchemaError)   detail.schema_errors.actual   = actualSchemaError;
      }

      details.push(detail);
    } catch (err) {
      const detail: FixtureTestDetail = {
        index:    i,
        status:   "error",
        expected: fixture.expected,
        error:    err instanceof Error ? err.message : String(err),
      };
      if (expectedSchemaError) {
        detail.schema_errors = { expected: expectedSchemaError };
      }
      details.push(detail);
    }
  }

  return {
    name:    pack.name,
    total:   details.length,
    passed:  details.filter(d => d.status === "pass").length,
    failed:  details.filter(d => d.status === "fail").length,
    errored: details.filter(d => d.status === "error").length,
    details,
  };
}
