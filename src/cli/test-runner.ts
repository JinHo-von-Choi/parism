import type { ParserPack } from "../parsers/registry.js";
import { diffJson, type ContractChange } from "../fixtures/replay.js";

export interface FixtureTestDetail {
  index:    number;
  status:   "pass" | "fail" | "error";
  expected: unknown;
  actual?:  unknown;
  error?:   string;
  /** 어디가 달라졌는지. 'fail' 일 때 사람이 결과물을 뒤져 볼 필요를 없게 한다. */
  changes?:  ContractChange[];
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
 *  3. **구조적** 동등성 검사 (diffJson). 객체 키 순서는 계약이 아니며 배열 순서는 값이다.
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

      /**
       * 3. 동등성 검사 — **구조적으로** 비교한다.
       *
       * 예전에는 `JSON.stringify(actual) === JSON.stringify(fixture.expected)` 였다.
       * 객체 키 순서만 달라져도 불일치로 fell 다. 파서가 키 순서를 바꾸는 것은
       * 계약 위반이 아닌데, 계약 위반처럼 보고됐다.
       * 계획서 4.5장: "JSON.stringify 의 키 순서 의존 비교를 구조적 비교로 바꾼다."
       *
       * 배열 순서는 값이므로 여전히 변화다 — 행 순서 재배열을 '순서만 바뀌었다' 고
       * 봐야 하는 경우(`compare_results`)와는 목적이 다르기 때문이다.
       */
      const changes = diffJson(fixture.expected, actual);
      const match   = changes.length === 0;

      const hasSchemaError = expectedSchemaError !== undefined || actualSchemaError !== undefined;
      const status         = (match && !hasSchemaError) ? "pass" : "fail";

      const detail: FixtureTestDetail = {
        index:    i,
        status,
        expected: fixture.expected,
        actual,
        ...(changes.length > 0 && { changes }),
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
