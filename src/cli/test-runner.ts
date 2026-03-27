import type { ParserPack } from "../parsers/registry.js";

export interface FixtureTestDetail {
  index:    number;
  status:   "pass" | "fail" | "error";
  expected: unknown;
  actual?:  unknown;
  error?:   string;
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
 */
export function runFixtureTests(pack: ParserPack): FixtureTestResults {
  const details: FixtureTestDetail[] = [];

  for (let i = 0; i < pack.fixtures.length; i++) {
    const fixture = pack.fixtures[i];

    try {
      const actual = pack.parse(fixture.input, fixture.args);
      const match  = JSON.stringify(actual) === JSON.stringify(fixture.expected);

      details.push({
        index:    i,
        status:   match ? "pass" : "fail",
        expected: fixture.expected,
        actual,
      });
    } catch (err) {
      details.push({
        index:    i,
        status:   "error",
        expected: fixture.expected,
        error:    err instanceof Error ? err.message : String(err),
      });
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
