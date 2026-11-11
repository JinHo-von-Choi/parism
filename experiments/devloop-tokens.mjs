/**
 * 시험·진단 파서의 토큰 수 측정.
 *
 * 러너가 낸 원문과 Parism이 돌려주는 파싱 결과의 토큰 수를 비교하고,
 * 원문에 있는 실패 항목·진단이 결과에 모두 있는지(recall) 센다.
 * 입력은 tests/parsers/devloop-fixtures 의 실제 러너 출력이다.
 *
 *   npm run build && node experiments/devloop-tokens.mjs
 *
 * 작성자: 최진호
 * 작성일: 2026-11-11
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { countTokens } from "gpt-tokenizer";
import { createRegistry } from "../dist/parsers/index.js";

const dir      = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "tests", "parsers", "devloop-fixtures");
const registry = createRegistry();

/** [표시 이름, 명령, 인자, fixture, 원문에서 실패·진단 수를 세는 함수] */
const CASES = [
  ["vitest (실패 2, 파일 오류 1)", "vitest", ["run", "--reporter=json"], "vitest-failing.txt", raw => JSON.parse(raw.slice(0, raw.lastIndexOf("}") + 1)).testResults.reduce((n, f) => n + f.assertionResults.filter(a => a.status === "failed").length + (f.status === "failed" && !f.assertionResults.some(a => a.status === "failed") ? 1 : 0), 0)],
  ["vitest (전부 통과)", "vitest", ["run", "--reporter=json"], "vitest-passing.txt", () => 0],
  ["jest (실패 1, 파일 오류 1)", "jest", ["--json"], "jest-failing.json", () => 2],
  ["pytest (실패 3, 오류 1)", "pytest", [], "pytest-fail.xml", raw => (raw.match(/<(failure|error) /g) ?? []).length],
  ["cargo test (실패 2)", "cargo", ["test"], "cargo-test-failing.txt", raw => (raw.match(/ \.\.\. FAILED$/gm) ?? []).length],
  ["go test (실패 3)", "go", ["test", "-json"], "go-test-failing.jsonl", raw => raw.split("\n").filter(l => l.includes('"Action":"fail"') && l.includes('"Test"')).length],
  ["tsc (오류 3)", "tsc", ["--pretty", "false"], "tsc-errors.txt", raw => raw.split("\n").filter(l => / error TS\d+: /.test(l)).length],
  ["eslint (문제 4)", "eslint", ["-f", "json"], "eslint-problems.json", raw => JSON.parse(raw).reduce((n, f) => n + f.messages.length, 0)],
  ["ruff (문제 6)", "ruff", ["check", "--output-format=json"], "ruff-problems.json", raw => JSON.parse(raw).length],
  ["mypy (오류 2)", "mypy", ["--output=json"], "mypy-errors.jsonl", raw => raw.split("\n").filter(Boolean).length],
  ["cargo build (오류 2)", "cargo", ["build", "--message-format=json"], "cargo-build-errors.jsonl", raw => raw.split("\n").filter(l => l.includes('"level":"error"')).length],
];

console.log("| 출력 | 원문 토큰 | 결과 토큰 | 비율 | 실패·진단 (원문 → 결과) |");
console.log("|-|-|-|-|-|");
let rawTotal = 0, parsedTotal = 0, expectedTotal = 0, foundTotal = 0;
for (const [label, cmd, args, file, countInRaw] of CASES) {
  const raw    = readFileSync(path.join(dir, file), "utf8");
  const result = registry.parse(cmd, args, raw, { maxItems: 0, format: "json" });
  if (result.parsed == null) throw new Error(`${label}: ${result.parse_error?.message ?? "no result"}`);
  const rawTokens    = countTokens(raw);
  const parsedTokens = countTokens(JSON.stringify(result.parsed));
  const expected     = countInRaw(raw);
  const found        = (result.parsed.failures ?? result.parsed.diagnostics).length;
  rawTotal += rawTokens; parsedTotal += parsedTokens; expectedTotal += expected; foundTotal += found;
  console.log(`| ${label} | ${rawTokens} | ${parsedTokens} | ${Math.round(parsedTokens / rawTokens * 100)}% | ${expected} → ${found} |`);
}
console.log(`| 합계 | ${rawTotal} | ${parsedTotal} | ${Math.round(parsedTotal / rawTotal * 100)}% | ${expectedTotal} → ${foundTotal} |`);
if (expectedTotal !== foundTotal) process.exitCode = 1;
