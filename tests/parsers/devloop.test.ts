/**
 * 개발 루프 파서(vitest, jest, tsc, eslint) 시험.
 * fixture는 각 도구가 실제로 낸 출력이다. 실패 항목은 기대 목록과 하나씩 대조한다.
 *
 * 작성자: 최진호
 * 작성일: 2026-11-11
 */

import { describe, it, expect } from "vitest";
import { readFileSync }         from "node:fs";
import path                     from "node:path";
import { createRegistry }       from "../../src/parsers/index.js";
import { machineFormatArgs, relativizeReport, resolveRunner } from "../../src/parsers/devloop/index.js";
import { parseJestReport }      from "../../src/parsers/devloop/jest-format.js";
import { parseTsc }             from "../../src/parsers/devloop/tsc.js";
import { parseEslint }          from "../../src/parsers/devloop/eslint.js";
import { MESSAGE_CHAR_LIMIT, type DiagnosticReport, type TestReport } from "../../src/parsers/devloop/types.js";

const fixture = (name: string): string => readFileSync(path.join(import.meta.dirname, "devloop-fixtures", name), "utf8");

describe("vitest 보고서", () => {
  it("실패한 시험과 실행하지 못한 파일을 모두 싣고 통과한 시험은 개수만 싣는다", () => {
    const report = parseJestReport("vitest", fixture("vitest-failing.txt")) as TestReport;

    expect(report).toMatchObject({ kind: "test", tool: "vitest", passed: 2, failed: 2, skipped: 1, todo: 1, total: 6, files_failed: 1, success: false });
    expect(report.failures.map(f => [f.id, f.line, f.column])).toEqual([
      ["/work/sample/tests/a.test.ts > math fails on purpose", 4, 48],
      ["/work/sample/tests/a.test.ts > math nested fails on purpose", 8, 85],
      ["/work/sample/tests/broken.test.ts > (file)", undefined, undefined],
    ]);
    expect(report.failures[0]!.message).toContain("expected 2 to be 3");
    expect(report.failures[2]!.message).toContain("Cannot find module './nowhere.js'");
    expect(JSON.stringify(report)).not.toContain("math adds");
  });

  it("보고서 뒤에 붙은 안내 문구를 건너뛰고 읽는다", () => {
    expect(fixture("vitest-failing.txt")).toContain("JSON report written to");
    expect(parseJestReport("vitest", fixture("vitest-passing.txt"))).toMatchObject({ passed: 1, failed: 0, success: true, failures: [] });
  });

  it("러너가 보고한 실패 수와 실패 항목 수가 다르면 결과를 만들지 않는다", () => {
    const raw = fixture("vitest-failing.txt").replace('"numFailedTests":2', '"numFailedTests":3');
    expect(() => parseJestReport("vitest", raw)).toThrow(/reported 3 failed test\(s\) but 2/);
  });

  it("이름이 같은 실패는 식별자가 겹치지 않게 번호를 붙인다", () => {
    const failing = { ancestorTitles: [], fullName: "same", title: "same", status: "failed", failureMessages: ["boom"] };
    const raw = JSON.stringify({
      numTotalTests: 2, numPassedTests: 0, numFailedTests: 2, numPendingTests: 0, numTodoTests: 0, success: false,
      testResults: [{ name: "/w/t.test.ts", status: "failed", assertionResults: [failing, failing] }],
    });
    const ids = (parseJestReport("jest", raw) as TestReport).failures.map(f => f.id);
    expect(ids).toEqual(["/w/t.test.ts > same", "/w/t.test.ts > same #2"]);
  });

  it("긴 실패 메시지는 상한에서 자르고 원래 길이를 남긴다", () => {
    const raw = JSON.stringify({
      numTotalTests: 1, numPassedTests: 0, numFailedTests: 1, success: false,
      testResults: [{ name: "/w/t.test.ts", status: "failed", assertionResults: [{ fullName: "long", status: "failed", failureMessages: ["x".repeat(MESSAGE_CHAR_LIMIT + 500)] }] }],
    });
    const failure = (parseJestReport("jest", raw) as TestReport).failures[0]!;
    expect(failure.message).toHaveLength(MESSAGE_CHAR_LIMIT);
    expect(failure.message_chars).toBe(MESSAGE_CHAR_LIMIT + 500);
  });

  it("보고서가 없는 출력은 null이다", () => {
    expect(parseJestReport("vitest", " RUN  v5.0.5\n ✓ tests/ok.test.ts (1 test)\n")).toBeNull();
  });
});

describe("tsc 진단", () => {
  it("파일, 줄, 열, 코드, 메시지를 읽고 코드별 개수를 낸다", () => {
    const report = parseTsc(fixture("tsc-errors.txt"));

    expect(report).toMatchObject({ kind: "diagnostics", tool: "tsc", errors: 3, warnings: 0, files: 2 });
    expect(report.diagnostics.map(d => [d.file, d.line, d.column, d.code])).toEqual([
      ["src/a.ts", 2, 7, "TS2322"],
      ["src/a.ts", 3, 14, "TS2322"],
      ["src/b.ts", 1, 22, "TS2307"],
    ]);
    expect(report.by_code).toEqual([{ code: "TS2322", count: 2 }, { code: "TS2307", count: 1 }]);
  });

  it("출력이 없으면 진단이 없는 보고서다", () => {
    expect(parseTsc("")).toMatchObject({ errors: 0, diagnostics: [] });
  });

  it("들여쓴 줄은 앞 진단의 메시지에 잇고, 위치 없는 오류도 읽는다", () => {
    const report = parseTsc("src/a.ts(1,1): error TS2345: Argument of type 'X'.\n  Type 'X' is missing property 'y'.\nerror TS5083: Cannot read file 'tsconfig.json'.\n");
    expect(report.diagnostics[0]!.message).toBe("Argument of type 'X'.\n  Type 'X' is missing property 'y'.");
    expect(report.diagnostics[1]).toEqual({ severity: "error", code: "TS5083", message: "Cannot read file 'tsconfig.json'." });
  });

  it("진단이 아닌 줄이 있으면 결과를 만들지 않는다", () => {
    expect(() => parseTsc("src/a.ts(1,1): error TS1: bad\nsomething else entirely\n")).toThrow(/not a diagnostic/);
  });

  it("항목 수 상한은 목록만 자르고 개수는 전체 기준으로 둔다", () => {
    const report = parseTsc(fixture("tsc-errors.txt"), { maxItems: 1, format: "json" });
    expect(report.diagnostics).toHaveLength(1);
    expect(report.diagnostics_omitted).toBe(2);
    expect(report.errors).toBe(3);
  });
});

describe("eslint 진단", () => {
  it("메시지를 모두 읽고 원문과 수정 제안은 싣지 않는다", () => {
    const report = parseEslint(fixture("eslint-problems.json")) as DiagnosticReport;

    expect(report).toMatchObject({ tool: "eslint", errors: 3, warnings: 1, files: 1 });
    expect(report.diagnostics.map(d => [d.line, d.column, d.severity, d.code])).toEqual([
      [1, 7, "warning", "no-unused-vars"],
      [2, 5, "error", "no-undef"],
      [2, 9, "error", "eqeqeq"],
      [2, 17, "error", "no-undef"],
    ]);
    expect(JSON.stringify(report)).not.toContain("suggestions");
    expect(JSON.stringify(report)).not.toContain("const unusedThing = 1;");
  });

  it("파일별 합계와 메시지 수가 다르면 결과를 만들지 않는다", () => {
    const raw = fixture("eslint-problems.json").replace('"errorCount":3', '"errorCount":4');
    expect(() => parseEslint(raw)).toThrow(/reported 5 problem\(s\) but 4/);
  });

  it("eslint 결과 배열이 아닌 출력은 null이다", () => {
    expect(parseEslint("/work/sample/src/c.js\n  1:7  warning  unused\n")).toBeNull();
    expect(parseEslint('{"a":1}')).toBeNull();
  });
});

describe("러너 인식과 기계용 형식 인자", () => {
  it("직접 실행과 npx 실행에서 러너를 찾는다", () => {
    expect(resolveRunner("vitest", ["run"])?.name).toBe("vitest");
    expect(resolveRunner("npx", ["--no", "tsc", "--noEmit"])).toMatchObject({ name: "tsc", prefix: ["--no", "tsc"], rest: ["--noEmit"] });
    expect(resolveRunner("npx", ["cowsay", "hi"])).toBeNull();
    expect(resolveRunner("npm", ["test"])).toBeNull();
  });

  it("형식 플래그가 없으면 덧붙이고, 이미 있으면 그대로 둔다", () => {
    expect(machineFormatArgs("npx", ["eslint", "src"])?.args).toEqual(["eslint", "src", "--format", "json"]);
    expect(machineFormatArgs("eslint", ["-f", "json", "src"])?.args).toEqual(["-f", "json", "src"]);
    expect(machineFormatArgs("tsc", ["--noEmit"])?.args).toEqual(["--noEmit", "--pretty", "false"]);
    expect(machineFormatArgs("jest", [])?.args).toEqual(["--json"]);
  });

  it("vitest는 보고서를 받을 파일 인자를 실행 전용으로 따로 낸다", () => {
    const machine = machineFormatArgs("npx", ["vitest", "run"])!;
    expect(machine.args).toEqual(["vitest", "run", "--reporter=json"]);
    expect(machine.reportFlag!("/tmp/x/report")).toEqual(["--outputFile=/tmp/x/report"]);
  });

  it("다른 형식을 지정했거나 결과를 파일로 보내면 바꾸지 않는다", () => {
    expect(machineFormatArgs("eslint", ["-f", "stylish", "src"])).toBeNull();
    expect(machineFormatArgs("eslint", ["-o", "out.json", "src"])).toBeNull();
    expect(machineFormatArgs("vitest", ["run", "--reporter=verbose"])).toBeNull();
    expect(machineFormatArgs("vitest", ["run", "--outputFile=r.json"])).toBeNull();
    expect(machineFormatArgs("tsc", ["--watch"])).toBeNull();
    expect(machineFormatArgs("npx", ["cowsay"])).toBeNull();
  });
});

describe("레지스트리에서의 개발 루프 파서", () => {
  const registry = createRegistry();

  it("기계용 형식이 아닌 실행은 unsupported_format이고 바꿀 인자를 안내한다", () => {
    const result = registry.parse("npx", ["eslint", "src"], "/work/sample/src/c.js\n  1:7  warning  x\n");
    expect(result.parsed).toBeNull();
    expect(result.parse_error?.reason).toBe("unsupported_format");
    expect(result.parse_error?.hint?.args).toEqual(["eslint", "src", "--format", "json"]);
  });

  it("기계용 형식 실행은 보고서를 낸다", () => {
    const result = registry.parse("npx", ["eslint", "src", "--format", "json"], fixture("eslint-problems.json"));
    expect(result.parsed).toMatchObject({ kind: "diagnostics", errors: 3 });
  });

  it("러너가 아닌 npx 실행은 파서가 없는 것으로 둔다", () => {
    expect(registry.parse("npx", ["cowsay", "hi"], "moo\n")).toEqual({ parsed: null });
  });

  it("개수가 맞지 않는 보고서는 unrecognized_output이다", () => {
    const raw = fixture("vitest-failing.txt").replace('"numFailedTests":2', '"numFailedTests":9');
    expect(registry.parse("vitest", ["run", "--reporter=json"], raw).parse_error?.reason).toBe("unrecognized_output");
  });
});

describe("relativizeReport()", () => {
  it("작업 디렉터리 접두사를 식별자, 파일, 메시지에서 뺀다", () => {
    const report = relativizeReport(parseJestReport("vitest", fixture("vitest-failing.txt")) as TestReport, "/work/sample");
    expect(report.failures[0]).toMatchObject({ id: "tests/a.test.ts > math fails on purpose", file: "tests/a.test.ts" });
    expect(report.failures[0]!.message).toContain("at tests/a.test.ts:4:48");
  });

  it("작업 디렉터리 밖의 경로는 그대로 둔다", () => {
    const report = relativizeReport(parseEslint(fixture("eslint-problems.json")) as DiagnosticReport, "/elsewhere");
    expect(report.diagnostics[0]!.file).toBe("/work/sample/src/c.js");
  });
});

describe("cargo test", () => {
  it("실패한 시험의 이름, 위치, 메시지를 읽고 통과한 시험은 개수만 싣는다", async () => {
    const { parseCargoTest } = await import("../../src/parsers/devloop/cargo.js");
    const report = parseCargoTest(fixture("cargo-test-failing.txt"))!;

    expect(report).toMatchObject({ kind: "test", tool: "cargo", passed: 1, failed: 2, skipped: 1, total: 4, success: false });
    expect(report.failures.map(f => [f.id, f.file, f.line, f.column])).toEqual([
      ["tests::fails_on_purpose", "src/lib.rs", 9, 29],
      ["tests::nested::panics", "src/lib.rs", 15, 52],
    ]);
    expect(report.failures[0]!.message).toContain("assertion `left == right` failed");
    expect(report.failures[1]!.message).toContain("boom: 42");
    expect(report.failures[1]!.message).toContain("noise from test");
    expect(JSON.stringify(report)).not.toContain("tests::adds");
  });

  it("시험 바이너리가 여럿이면 합계를 더한다", async () => {
    const { parseCargoTest } = await import("../../src/parsers/devloop/cargo.js");
    const raw = [
      "running 2 tests", "test a ... ok", "test b ... ok", "",
      "test result: ok. 2 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s", "",
      "running 1 test", "test c ... ok", "",
      "test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 3 filtered out; finished in 0.01s", "",
    ].join("\n");
    expect(parseCargoTest(raw)).toMatchObject({ passed: 3, failed: 0, total: 3, success: true, failures: [] });
  });

  it("보고한 실패 수와 FAILED 줄 수가 다르면 결과를 만들지 않는다", async () => {
    const { parseCargoTest } = await import("../../src/parsers/devloop/cargo.js");
    const raw = fixture("cargo-test-failing.txt").replace("2 failed;", "1 failed;");
    expect(() => parseCargoTest(raw)).toThrow(/reported 1 failed test\(s\) but 2 FAILED/);
  });

  it("결과 줄이 없는 출력(컴파일 실패)은 null이다", async () => {
    const { parseCargoTest } = await import("../../src/parsers/devloop/cargo.js");
    expect(parseCargoTest("")).toBeNull();
    expect(parseCargoTest("error: could not compile `sample`\n")).toBeNull();
  });

  it("진행 상태 추적기는 조각 사이에서 끊긴 줄을 이어 읽는다", async () => {
    const { CargoTestProgress } = await import("../../src/parsers/devloop/cargo.js");
    const progress = new CargoTestProgress();
    progress.push("running 3 tests\ntest a ... o");
    expect(progress.snapshot()).toEqual({ passed: 0, failed: 0, skipped: 0, failed_names: [] });
    progress.push("k\ntest b ... FAILED\ntest c ... ignored, slow\n");
    expect(progress.snapshot()).toEqual({ passed: 1, failed: 1, skipped: 1, failed_names: ["b"] });
  });
});

describe("cargo build", () => {
  it("컴파일 오류의 파일, 줄, 열, 코드를 읽고 안내 문구 줄은 세지 않는다", async () => {
    const { parseCargoBuild } = await import("../../src/parsers/devloop/cargo.js");
    const report = parseCargoBuild(fixture("cargo-build-errors.jsonl"))!;

    expect(report).toMatchObject({ kind: "diagnostics", tool: "cargo", errors: 2, warnings: 0, files: 1 });
    expect(report.diagnostics.map(d => [d.file, d.line, d.column, d.code, d.message])).toEqual([
      ["src/bad.rs", 3, 18, "E0308", "mismatched types"],
      ["src/bad.rs", 4, 5, "E0425", "cannot find function `undefined_fn` in this scope"],
    ]);
  });

  it("오류 없는 빌드는 진단이 없는 보고서다", async () => {
    const { parseCargoBuild } = await import("../../src/parsers/devloop/cargo.js");
    expect(parseCargoBuild(fixture("cargo-build-ok.jsonl"))).toMatchObject({ errors: 0, diagnostics: [] });
  });

  it("build-finished 줄이 없거나 JSON이 아닌 줄이 섞이면 결과를 만들지 않는다", async () => {
    const { parseCargoBuild } = await import("../../src/parsers/devloop/cargo.js");
    const lines = fixture("cargo-build-errors.jsonl").trimEnd().split("\n");
    expect(() => parseCargoBuild(lines.slice(0, -1).join("\n"))).toThrow(/without a build-finished line/);
    expect(() => parseCargoBuild([lines[0], "warning: plain text", ...lines.slice(1)].join("\n"))).toThrow(/not JSON/);
    expect(parseCargoBuild("   Compiling sample v0.1.0\n")).toBeNull();
  });
});

describe("cargo 러너 인식", () => {
  const registry = createRegistry();

  it("test, build, check는 개발 루프 파서가, tree는 기존 파서가 읽는다", () => {
    expect(resolveRunner("cargo", ["test", "--lib"])).toMatchObject({ name: "cargo test", prefix: ["test"], rest: ["--lib"] });
    expect(resolveRunner("cargo", ["+nightly", "check"])?.name).toBe("cargo check");
    expect(resolveRunner("cargo", ["tree"])).toBeNull();
    expect(registry.parse("cargo", ["tree"], "sample v0.1.0 (/work/sample)\n").parsed).toMatchObject({ crates: [{ name: "sample" }] });
  });

  it("build와 check는 json 형식을 덧붙이고, 다른 형식이 지정돼 있으면 바꾸지 않는다", () => {
    expect(machineFormatArgs("cargo", ["build", "--release"])?.args).toEqual(["build", "--release", "--message-format=json"]);
    expect(machineFormatArgs("cargo", ["check", "--message-format=json"])?.args).toEqual(["check", "--message-format=json"]);
    expect(machineFormatArgs("cargo", ["build", "--message-format=short"])).toBeNull();
    expect(machineFormatArgs("cargo", ["test", "--lib"])?.args).toEqual(["test", "--lib"]);
    expect(machineFormatArgs("cargo", ["test", "--", "--format", "json"])).toBeNull();
  });

  it("json 형식이 아닌 cargo build는 unsupported_format이고 바꿀 인자를 안내한다", () => {
    const result = registry.parse("cargo", ["build"], "");
    expect(result.parse_error?.reason).toBe("unsupported_format");
    expect(result.parse_error?.hint?.args).toEqual(["build", "--message-format=json"]);
  });

  it("레지스트리를 거쳐 cargo test 출력을 보고서로 만든다", () => {
    expect(registry.parse("cargo", ["test"], fixture("cargo-test-failing.txt")).parsed).toMatchObject({ kind: "test", failed: 2 });
  });
});

describe("jest 보고서", () => {
  it("jest가 낸 보고서에서 실패한 시험과 실행하지 못한 파일을 읽는다", () => {
    const report = parseJestReport("jest", fixture("jest-failing.json")) as TestReport;

    expect(report).toMatchObject({ tool: "jest", passed: 1, failed: 1, skipped: 1, todo: 1, total: 4, files_failed: 1 });
    expect(report.failures.map(f => [f.id, f.line])).toEqual([
      ["/work/sample/tests/broken.test.js > (file)", undefined],
      ["/work/sample/tests/a.test.js > math fails on purpose", 3],
    ]);
    expect(report.failures[0]!.message).toContain("Cannot find module './nowhere'");
  });
});

describe("pytest JUnit XML", () => {
  it("실패, 준비 단계 오류, 건너뜀을 세고 실패한 시험의 위치와 메시지를 읽는다", async () => {
    const { parseJunitXml } = await import("../../src/parsers/devloop/junit.js");
    const report = parseJunitXml("pytest", fixture("pytest-fail.xml"))!;

    expect(report).toMatchObject({ kind: "test", tool: "pytest", passed: 2, failed: 4, skipped: 1, total: 7, files_failed: 0, success: false });
    expect(report.failures.map(f => [f.id, f.file, f.line])).toEqual([
      ["tests.test_sample::test_fails_on_purpose", "tests/test_sample.py", 7],
      ["tests.test_sample.TestNested::test_raises", "tests/test_sample.py", 16],
      ["tests.test_sample::test_error_in_setup", "tests/test_sample.py", 20],
      ["tests.test_sample::test_param[2]", "tests/test_sample.py", 27],
    ]);
    expect(report.failures[1]!.message).toContain('ValueError: boom <&> "quoted"');
    expect(report.failures[2]!.message).toContain('failed on setup with "RuntimeError: fixture failed"');
  });

  it("시험 모듈을 가져오지 못한 오류는 실행하지 못한 파일로 센다", async () => {
    const { parseJunitXml } = await import("../../src/parsers/devloop/junit.js");
    const report = parseJunitXml("pytest", fixture("pytest-collect.xml"))!;

    expect(report).toMatchObject({ passed: 0, failed: 0, total: 0, files_failed: 1, success: false });
    expect(report.failures[0]).toMatchObject({ id: "tests.test_broken_import", name: "(file)", file: "tests/test_broken_import.py", line: 1 });
    expect(report.failures[0]!.message).toContain("ModuleNotFoundError");
  });

  it("보고서의 개수와 실패를 가진 시험 수가 다르면 결과를 만들지 않는다", async () => {
    const { parseJunitXml } = await import("../../src/parsers/devloop/junit.js");
    const raw = fixture("pytest-fail.xml").replace('failures="3"', 'failures="2"');
    expect(() => parseJunitXml("pytest", raw)).toThrow(/counts 2 failure\(s\) and 1 error\(s\) but 3 and 1/);
  });

  it("CDATA 본문과 문자 참조를 읽고, XML이 아닌 출력은 null이다", async () => {
    const { parseJunitXml, decodeXml } = await import("../../src/parsers/devloop/junit.js");
    const raw = '<testsuite tests="1" failures="1" errors="0" skipped="0"><testcase classname="m" name="t"><failure message="a &#60; b"><![CDATA[x < y && z]]> tail &amp; more</failure></testcase></testsuite>';
    expect(parseJunitXml("pytest", raw)!.failures[0]!.message).toBe("a < b\nx < y && z tail & more");
    expect(decodeXml("&#x41;&unknown;&apos;")).toBe("A&unknown;'");
    expect(parseJunitXml("pytest", "===== 3 failed, 2 passed =====\n")).toBeNull();
  });
});

describe("go test", () => {
  it("시험마다 통과·실패·건너뜀을 세고 실패한 시험의 출력을 메시지로 싣는다", async () => {
    const { parseGoTest } = await import("../../src/parsers/devloop/gotest.js");
    const report = parseGoTest(fixture("go-test-failing.jsonl"))!;

    expect(report).toMatchObject({ kind: "test", tool: "go", passed: 2, failed: 3, skipped: 1, total: 6, files_failed: 0, success: false });
    expect(report.failures.map(f => [f.id, f.file, f.line])).toEqual([
      ["sample > TestFailsOnPurpose", "sample_test.go", 17],
      ["sample > TestNested/inner_fails", "sample_test.go", 24],
      ["sample > TestNested", "", undefined],
    ]);
    expect(report.failures[0]!.message).toBe("noise from test\n    sample_test.go:17: expected 3, got 2");
  });

  it("시험 없이 실패로 끝난 패키지(빌드 실패)를 싣는다", async () => {
    const { parseGoTest } = await import("../../src/parsers/devloop/gotest.js");
    const report = parseGoTest(fixture("go-test-build-fail.jsonl"))!;

    expect(report).toMatchObject({ passed: 0, failed: 0, files_failed: 1, success: false });
    expect(report.failures).toEqual([{ id: "sample > (package)", file: "", name: "(package)", message: "FAIL\tsample [build failed]" }]);
  });

  it("끝나지 않은 패키지가 있거나 JSON이 아닌 줄이 섞이면 결과를 만들지 않는다", async () => {
    const { parseGoTest } = await import("../../src/parsers/devloop/gotest.js");
    const lines = fixture("go-test-failing.jsonl").trimEnd().split("\n");
    expect(() => parseGoTest(lines.slice(0, -1).join("\n"))).toThrow(/before package sample finished/);
    expect(() => parseGoTest([lines[0], "panic: runtime error", ...lines.slice(1)].join("\n"))).toThrow(/not a JSON event/);
    expect(parseGoTest("ok  \tsample\t0.005s\n")).toBeNull();
  });

  it("진행 상태 추적기는 끝난 시험을 센다", async () => {
    const { GoTestProgress } = await import("../../src/parsers/devloop/gotest.js");
    const progress = new GoTestProgress();
    const raw      = fixture("go-test-failing.jsonl");
    progress.push(raw.slice(0, 1500));
    const early = progress.snapshot();
    progress.push(raw.slice(1500));
    expect(early.passed + early.failed).toBeGreaterThan(0);
    expect(progress.snapshot()).toEqual({ passed: 2, failed: 3, skipped: 1, failed_names: ["TestFailsOnPurpose", "TestNested/inner_fails", "TestNested"] });
  });
});

describe("ruff와 mypy", () => {
  it("ruff의 문제 배열을 읽고 수정 제안은 싣지 않는다", async () => {
    const { parseRuff } = await import("../../src/parsers/devloop/python-lint.js");
    const report = parseRuff(fixture("ruff-problems.json"))!;

    expect(report).toMatchObject({ kind: "diagnostics", tool: "ruff", errors: 6, files: 1 });
    expect(report.diagnostics.map(d => [d.line, d.column, d.code])).toEqual([
      [1, 1, "I001"], [1, 8, "F401"], [1, 12, "F401"], [2, 8, "F401"], [10, 5, "F841"], [11, 12, "F821"],
    ]);
    expect(report.by_code[0]).toEqual({ code: "F401", count: 3 });
    expect(JSON.stringify(report)).not.toContain("applicability");
    expect(parseRuff("[]")).toMatchObject({ errors: 0, diagnostics: [] });
    expect(parseRuff("F401 [*] `os` imported but unused\n")).toBeNull();
    expect(() => parseRuff('[{"code":"F401"}]')).toThrow(/item 0 is not a diagnostic/);
  });

  it("mypy의 줄 단위 JSON을 읽고 열을 1부터 세는 값으로 바꾼다", async () => {
    const { parseMypy } = await import("../../src/parsers/devloop/python-lint.js");
    const report = parseMypy(fixture("mypy-errors.jsonl"))!;

    expect(report).toMatchObject({ tool: "mypy", errors: 2, files: 1 });
    expect(report.diagnostics.map(d => [d.file, d.line, d.column, d.severity, d.code])).toEqual([
      ["pkg/mod.py", 7, 10, "error", "assignment"],
      ["pkg/mod.py", 8, 12, "error", "arg-type"],
    ]);
    expect(parseMypy("")).toMatchObject({ errors: 0, diagnostics: [] });
    expect(parseMypy("pkg/mod.py:7: error: Incompatible types\n")).toBeNull();
    expect(() => parseMypy(fixture("mypy-errors.jsonl") + "Found 2 errors\n")).toThrow(/not JSON/);
  });
});

describe("pytest, go, ruff, mypy 러너 인식", () => {
  const registry = createRegistry();

  it("서브커맨드가 맞을 때만 러너로 본다", () => {
    expect(resolveRunner("go", ["test", "./..."])?.name).toBe("go test");
    expect(resolveRunner("go", ["build", "./..."])).toBeNull();
    expect(resolveRunner("ruff", ["check", "."])?.name).toBe("ruff check");
    expect(resolveRunner("ruff", ["format", "."])).toBeNull();
    expect(resolveRunner("pytest", ["-x"])?.name).toBe("pytest");
    expect(resolveRunner("mypy", ["src"])?.name).toBe("mypy");
  });

  it("형식 인자를 덧붙이고, pytest는 보고서 파일 인자를 실행 전용으로 낸다", () => {
    expect(machineFormatArgs("go", ["test", "./..."])?.args).toEqual(["test", "-json", "./..."]);
    expect(machineFormatArgs("ruff", ["check", "src"])?.args).toEqual(["check", "src", "--output-format=json"]);
    expect(machineFormatArgs("mypy", ["src"])?.args).toEqual(["src", "--output=json"]);
    const pytest = machineFormatArgs("pytest", ["tests", "-x"])!;
    expect(pytest.args).toEqual(["tests", "-x"]);
    expect(pytest.reportFlag!("/tmp/r/report")).toEqual(["--junitxml=/tmp/r/report"]);
  });

  it("다른 형식을 지정했거나 결과를 파일로 보내면 바꾸지 않는다", () => {
    expect(machineFormatArgs("ruff", ["check", "--output-format", "sarif"])).toBeNull();
    expect(machineFormatArgs("ruff", ["check", "-o", "out.json"])).toBeNull();
    expect(machineFormatArgs("mypy", ["--output", "text", "src"])).toBeNull();
    expect(machineFormatArgs("pytest", ["--junitxml=mine.xml"])).toBeNull();
    expect(machineFormatArgs("go", ["test", "-c"])).toBeNull();
    expect(machineFormatArgs("go", ["vet", "./..."])).toBeNull();
  });

  it("기계용 형식이 아닌 실행은 바꿀 인자나 방법을 알려 준다", () => {
    expect(registry.parse("ruff", ["check", "src"], "F401 unused\n").parse_error?.hint?.args).toEqual(["check", "src", "--output-format=json"]);
    expect(registry.parse("go", ["test", "./..."], "ok  \tsample\t0.005s\n").parse_error?.hint?.args).toEqual(["test", "-json", "./..."]);
    const pytest = registry.parse("pytest", ["tests"], "===== 1 failed in 0.1s =====\n");
    expect(pytest.parse_error?.reason).toBe("unrecognized_output");
    expect(pytest.parse_error?.message).toMatch(/machine_format true/);
  });

  it("러너가 아닌 서브커맨드는 파서가 없는 것으로 둔다", () => {
    expect(registry.parse("go", ["version"], "go version go1.23.4 linux/amd64\n")).toEqual({ parsed: null });
    expect(registry.parse("ruff", ["format", "."], "1 file left unchanged\n")).toEqual({ parsed: null });
  });
});

describe("개발 루프 파서의 필드 근거", () => {
  /** 근거 구간이 가리키는 원문 글자 */
  const quote = (raw: string, span: { line: number; start: number; end: number }): string =>
    raw.split("\n")[span.line - 1]!.slice(span.start, span.end);

  it("tsc 진단의 파일, 줄, 열, 코드, 메시지 구간이 파싱한 값과 같다", async () => {
    const { tscEvidence } = await import("../../src/parsers/devloop/evidence.js");
    const raw      = fixture("tsc-errors.txt");
    const report   = parseTsc(raw);
    const evidence = tscEvidence(raw);

    report.diagnostics.forEach((d, i) => {
      expect(quote(raw, evidence[`/diagnostics/${i}/file`]![0]!)).toBe(d.file);
      expect(Number(quote(raw, evidence[`/diagnostics/${i}/line`]![0]!))).toBe(d.line);
      expect(Number(quote(raw, evidence[`/diagnostics/${i}/column`]![0]!))).toBe(d.column);
      expect(quote(raw, evidence[`/diagnostics/${i}/code`]![0]!)).toBe(d.code);
      expect(quote(raw, evidence[`/diagnostics/${i}/message`]![0]!)).toBe(d.message);
    });
    expect(Object.keys(evidence)).toHaveLength(report.diagnostics.length * 5);
  });

  it("여러 줄에 걸친 tsc 메시지는 가리키지 않는다", async () => {
    const { tscEvidence } = await import("../../src/parsers/devloop/evidence.js");
    const evidence = tscEvidence("src/a.ts(1,1): error TS2345: Argument of type 'X'.\n  Type 'X' is missing 'y'.\n");
    expect(evidence["/diagnostics/0/message"]).toBeUndefined();
    expect(evidence["/diagnostics/0/code"]).toBeDefined();
  });

  it("cargo test와 go test는 실패한 시험의 이름 구간을 낸다", async () => {
    const { cargoTestEvidence, goTestEvidence } = await import("../../src/parsers/devloop/evidence.js");
    const { parseCargoTest } = await import("../../src/parsers/devloop/cargo.js");
    const { parseGoTest }    = await import("../../src/parsers/devloop/gotest.js");

    const cargoRaw = fixture("cargo-test-failing.txt");
    const cargo    = cargoTestEvidence(cargoRaw);
    parseCargoTest(cargoRaw)!.failures.forEach((f, i) => expect(quote(cargoRaw, cargo[`/failures/${i}/name`]![0]!)).toBe(f.name));

    const goRaw = fixture("go-test-failing.jsonl");
    const go    = goTestEvidence(goRaw);
    parseGoTest(goRaw)!.failures.forEach((f, i) => expect(quote(goRaw, go[`/failures/${i}/name`]![0]!)).toBe(f.name));
  });

  it("mypy와 cargo build는 JSON 줄에서 이스케이프가 없는 문자열 값의 구간을 낸다", async () => {
    const { mypyEvidence, cargoBuildEvidence } = await import("../../src/parsers/devloop/evidence.js");
    const { parseMypy }       = await import("../../src/parsers/devloop/python-lint.js");
    const { parseCargoBuild } = await import("../../src/parsers/devloop/cargo.js");

    const mypyRaw = fixture("mypy-errors.jsonl");
    const mypy    = mypyEvidence(mypyRaw);
    const report  = parseMypy(mypyRaw)!;
    expect(quote(mypyRaw, mypy["/diagnostics/0/file"]![0]!)).toBe(report.diagnostics[0]!.file);
    expect(quote(mypyRaw, mypy["/diagnostics/1/code"]![0]!)).toBe("arg-type");
    /** 따옴표가 든 메시지는 원문에서 이스케이프되어 글자가 다르므로 가리키지 않는다. */
    expect(report.diagnostics[0]!.message).toContain('"str"');
    expect(mypy["/diagnostics/0/message"]).toBeUndefined();

    const cargoRaw = fixture("cargo-build-errors.jsonl");
    const cargo    = cargoBuildEvidence(cargoRaw);
    const build    = parseCargoBuild(cargoRaw)!;
    expect(quote(cargoRaw, cargo["/diagnostics/0/message"]![0]!)).toBe(build.diagnostics[0]!.message);
    expect(quote(cargoRaw, cargo["/diagnostics/1/code"]![0]!)).toBe("E0425");
  });

  it("JSON 문서 하나나 보고서 파일을 읽는 러너는 근거를 내지 않는다", async () => {
    const { devloopEvidence } = await import("../../src/parsers/devloop/index.js");
    expect(devloopEvidence("eslint", ["-f", "json"], fixture("eslint-problems.json"))).toEqual({});
    expect(devloopEvidence("vitest", ["run", "--reporter=json"], fixture("vitest-failing.txt"))).toEqual({});
    expect(devloopEvidence("npx", ["cowsay"], "moo")).toEqual({});
  });
});
