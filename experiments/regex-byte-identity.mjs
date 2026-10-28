#!/usr/bin/env node
/**
 * 정규식 엔진 바이트 동일성 검증 — Phase 3 TASK-027.
 *
 * ## 무엇을 재는가
 *
 * Rust 정규식 엔진을 켜도 **출력이 한 바이트도 달라지지 않는다**는 사실.
 * "Rust 가 빠르다" 와 "Rust 가 같은 결과를 낸다" 는 별개다. 이것은 두 번째를 잰다.
 *
 * ## 왜 실험으로 따로 두는가
 *
 * 이 검증은 **통과하면 아무 말도 하지 않는 시험**이다. 지나가면 아무도 본다.
 * 그러면 통과 사유를 나중에 알 수 없다 — Rust 가 한 번도 안 돌아갔는데 통과했을 수도 있다.
 *
 * 그래서 **측정값을 기록한다.**
 *
 * - `rustEngaged` — Rust 엔진이 실제로 처리한 연산 수. 0 이면 검증한 것이 아니다.
 * - `redactions` — 실제로 뭔가를 가린 횟수. 0 이면 비교할 것이 없었다.
 * - `mismatches` — 바이트가 달라진 항목. **0 이어야 한다.**
 *
 * ## 코퍼스의 함정
 *
 * `parism test` 코퍼스(27 fixture / 2,591 바이트)에는 기본 리댁션 패턴이 **한 번도 걸리지 않는다**(실측).
 * 원본만 비교하면 두 결과가 처음부터 같아서 통과한다 — 통과한 것이 아니라 비교할 것이 없었다.
 * 그래서 비밀 형태 문자열을 섞은 파생 항목을 함께 비교한다.
 *
 * ## 쓰기
 *
 *   npm run build
 *   node experiments/regex-byte-identity.mjs
 *   node experiments/regex-byte-identity.mjs --out experiments/regex-byte-identity/results.json
 *
 * ## 종료 코드
 *
 *   0 — 불일치 0건 **이고** Rust 가 실제로 돌았고 뭔가를 가렸다.
 *   1 — 불일치가 있거나, Rust 가 한 번도 안 돌았거나, 가린 것이 없다.
 *
 * 작성자: 최진호
 * 작성일: 2026-10-22
 */

import { writeFileSync, mkdirSync } from "node:fs";
import { dirname }                from "node:path";

import { verifyByteIdentity } from "../dist/engine/regex-byte-identity.js";

const args = process.argv.slice(2);
const outIndex = args.indexOf("--out");
const outPath  = outIndex >= 0 ? args[outIndex + 1] : undefined;

/** Rust 바이너리가 없으면 검증한 것이 아니다. CI 는 하드 실패를 원한다. */
const requireNative = process.env.PARISM_REQUIRE_NATIVE === "1";

const started = Date.now();
const report  = await verifyByteIdentity({});
const elapsedMs = Date.now() - started;

const summary = {
  generated_at: new Date().toISOString(),
  elapsed_ms:   elapsedMs,
  corpus:       report.corpus,
  comparisons:  report.comparisons,
  bytes:        report.bytes,
  mismatches:   report.mismatches.length,
  rust_engaged: report.rustEngaged,
  redactions:   report.redactions,
  native_available: report.nativeAvailable,
  fallbacks:    report.fallbacks.map(f => ({ pattern: f.pattern, reason: f.reason })),
};

console.log("정규식 엔진 바이트 동일성");
console.log(`  코퍼스          팩 fixture ${report.corpus.packFixtures} · manifest ${report.corpus.manifestFixtures} · 파생 ${report.corpus.derived}`);
console.log(`  비교            ${report.comparisons}건 / ${report.bytes} 바이트`);
console.log(`  불일치          ${report.mismatches.length}건`);
console.log(`  Rust 실제 실행  ${report.rustEngaged}회`);
console.log(`  실제 가림       ${report.redactions}회`);
console.log(`  되돌아간 패턴   ${report.fallbacks.length}종`);
for (const f of report.fallbacks) {
  console.log(`    - ${f.pattern}  →  ${f.reason.split("\n")[0]}`);
}
console.log(`  소요 시간       ${elapsedMs}ms`);

if (report.mismatches.length > 0) {
  console.error("\n바이트가 다른 항목:");
  for (const m of report.mismatches.slice(0, 10)) {
    console.error(`  ${m.label}\n${m.sample}\n`);
  }
}

/** 검증을 했다고 말할 수 있는 조건. 하나라도 어긋나면 "검증 실패" 다. */
const failures = [];
if (report.mismatches.length > 0) failures.push(`바이트 불일치 ${report.mismatches.length}건`);
if (report.rustEngaged === 0) {
  const hint = requireNative
    ? "PARISM_REQUIRE_NATIVE=1 이므로 Rust 바이너리 부재를 실패로 센다"
    : "Rust 정규식 바이너리를 빌드하지 않으면 검증한 것이 아니다";
  failures.push(`Rust 엔진이 한 번도 실행되지 않았다 (${hint})`);
}
if (report.redactions === 0) failures.push("비교할 것이 없었다 — 리댁션 패턴이 한 번도 안 걸렸다");

if (outPath) {
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, `${JSON.stringify({ ...summary, mismatch_details: report.mismatches }, null, 2)}\n`, "utf8");
  console.log(`\n기록: ${outPath}`);
}

if (failures.length > 0) {
  console.error(`\n검증 실패: ${failures.join(" · ")}`);
  process.exit(1);
}
console.log("\n검증 성공 — 바이트 불일치 0건, Rust 엔진이 실제로 돌았다.");
