/**
 * 사람 실험 결과 분석 — 5~8명, 과제 30개, 반복 5회.
 *
 * 절차서: PROCEDURE.md · 과제: TASKS.md · 기록: scoringsheet.csv
 *
 * ## 이 스크립트가 하지 **않는** 것
 *
 * **판정하지 않는다.** 통과/실패를 말하지 않고 숫자를 낸다. 사람이 읽고 판단한다.
 *
 * **표본이 모자라면 모자라고 먼저 말한다.** n < 5 이면 신뢰구간 대신 그 사실을 출력한다.
 * 유의성 검정을 하지 않는다. 이 설계로는 할 수 없다 — 그래도 구간을 붙이는 이유는
 * '점 하나가 아니라 범위로 읽어야 한다' 를 강제하기 위해서다.
 *
 * **평균을懒得 쓰지 않는다.** 시도 횟수와 확인 시간은 분포를 보고 중앙값을 쓴다.
 * 3명이 5분씩 멈춰 서 있으면 평균은 아무 의미도 없다.
 *
 * 실행: `node experiments/human-study/analyze.mjs <scoringsheet.csv>`
 *
 * 작성자: 최진호
 * 작성일: 2026-10-05
 */

import { readFileSync } from "node:fs";

/** 결정론적 난수 — 하네스와 같은 SEED 규칙. 재현되는 분석을 위해. */
const SEED = 20261005;
const BOOTSTRAP = 2000;

function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

const MIN_N = 5;
/**
 * 실험군. **A/B 를 손으로 반복해서 쓰지 않는다.**
 *
 * 이 상수가 코드에 있는데 쓰이지 않았다. 쓰이지 않는 채로 "A" 와 "B" 가 여덟 곳에
 * 흩어져 있었다 — 실험군 이름을 한 군데서 바꿔야 할 때 여덟 군데를 함께 바꿔야 하는
 * 상태였고, 하나만 빠지면 한쪽 실험군이 조용히 0건이 된다.
 *
 * 키가 곧 채점 시트의 `arm` 열 값이다. 여기 없는 값이 들어오면 **거절한다**
 * (알 수 없는 실험군을 조용히 버리지 않는다).
 */
const ARMS = { A: "기준선(평소 쓰는 도구)", B: "후보(parism)" };
const ARM_KEYS = Object.keys(ARMS);
const isArm = v => ARM_KEYS.includes(v);

/**
 * 비율의 신뢰구간 — Wilson.
 * 정규 근사는 n 이 작을 때 틀린다. 5~8명 규모에서는 거의 항상 틀리므로 Wilson 을 쓴다.
 */
function wilson(successes, n, z = 1.96) {
  if (n === 0) return { lo: NaN, hi: NaN };
  const p = successes / n;
  const d = 1 + (z * z) / n;
  const centre = p + (z * z) / (2 * n);
  const spread = z * Math.sqrt((p * (1 - p) + (z * z) / (4 * n)) / n);
  return { lo: Math.max(0, (centre - spread) / d), hi: Math.min(1, (centre + spread) / d) };
}

const pct = v => Number.isFinite(v) ? `${(v * 100).toFixed(1)}%` : "—";
const median = xs => {
  if (xs.length === 0) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const quantile = (xs, q) => {
  if (xs.length === 0) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const pos = (s.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return lo === hi ? s[lo] : s[lo] + (s[hi] - s[lo]) * (pos - lo);
};

/** 쌍을 이룬 정확률 차이: 같은 (참가자, 과제, 반복) 에서 A 와 B 를 뺀다. */
function pairedAccuracyCI(rows) {
  /** (참가자, 과제, 반복) 별 A/B 를 맞춘다. 짝이 안 맞으면 제외하고 그 수를 밝힌다. */
  const byKey = new Map();
  for (const r of rows) {
    const k = `${r.participant}|${r.task_id}|${r.attempt_no}`;
    const slot = byKey.get(k) ?? {};
    slot[r.arm] = r;
    byKey.set(k, slot);
  }
  const pairs = [];
  let unmatched = 0;
  for (const [k, slot] of byKey) {
    if (!slot.A || !slot.B) { unmatched++; continue; }
    pairs.push({ key: k, aOk: slot.A.correct, bOk: slot.B.correct });
  }
  if (pairs.length < MIN_N) return { lo: NaN, hi: NaN, n: pairs.length, unmatched, diff: NaN };

  const rand = rng(SEED);
  const diffs = [];
  for (let b = 0; b < BOOTSTRAP; b++) {
    let a = 0;
    let c = 0;
    for (let i = 0; i < pairs.length; i++) {
      const p = pairs[Math.floor(rand() * pairs.length)];
      a += p.aOk;
      c += p.bOk;
    }
    diffs.push(c / pairs.length - a / pairs.length);
  }
  const point = pairs.reduce((s, p) => s + (p.bOk - p.aOk), 0) / pairs.length;
  return { lo: quantile(diffs, 0.025), hi: quantile(diffs, 0.975), n: pairs.length, unmatched, diff: point };
}

// ── 입력 ──────────────────────────────────────────────────────────────────

const path = process.argv[2];
if (!path) {
  console.error("사용법: node experiments/human-study/analyze.mjs <scoringsheet.csv>");
  process.exit(1);
}

const lines = readFileSync(path, "utf8").split("\n")
  .map(l => l.trim())
  .filter(l => l.length > 0 && !l.startsWith("#"));

/**
 * 헤더가 없으면 열이 한 칸씩 밀려 조용히 엉뚱한 숫자가 나온다.
 * 그게 이 프로젝트가 가장 경계하는 실패이므로 먼저 막는다.
 */
if (!lines[0].startsWith("run_id")) {
  console.error("첫 줄이 run_id 로 시작하는 헤더가 아니다. 열이 밀려 숫자가 엉뚱하게 나올 수 있다.\n");
  console.error("scoringsheet.csv 의 헤더를 그대로 복사해 붙였는지 확인해라.\n");
  process.exit(1);
}

const header = lines[0].split(",");
const rows = lines.slice(1).map(l => {
  const cells = l.split(",");
  const o = {};
  header.forEach((h, i) => { o[h] = cells[i] ?? ""; });
  return {
    run_id: o.run_id, task_id: o.task_id, participant: o.participant, arm: o.arm,
    attempt_no: Number(o.attempt_no), correct: Number(o.correct), wrong_kind: o.wrong_kind,
    attempts: Number(o.attempts), verify_seconds: Number(o.verify_seconds),
    gave_up: o.gave_up, reason: o.reason,
  };
});

// ── 데이터 상태 점검 ──────────────────────────────────────────────────────

const problems = [];
if (rows.length === 0) {
  console.log("기록이 없다. 이 파일에는 결과가 없습니다.\n");
  console.log("채점 시트를 채우기 전까지는 어떤 결론도 읽을 수 없습니다.");
  process.exit(0);
}
const badKind = rows.filter(r => r.wrong_kind === "none" && r.correct !== 1);
if (badKind.length) problems.push(`wrong_kind=none 인데 correct=1 이 아닌 기록 ${badKind.length}건`);
const badKind2 = rows.filter(r => r.correct === 1 && r.wrong_kind !== "none");
if (badKind2.length) problems.push(`correct=1 인데 wrong_kind=none 이 아닌 기록 ${badKind2.length}건`);
const badArm = rows.filter(r => !isArm(r.arm));
if (badArm.length) problems.push(`arm 이 ${ARM_KEYS.join("/")} 가운데 어느 것도 아닌 기록 ${badArm.length}건`);
const noTime = rows.filter(r => !Number.isFinite(r.verify_seconds) || r.verify_seconds <= 0);
if (noTime.length) problems.push(`verify_seconds 가 없는 기록 ${noTime.length}건`);

const participants = [...new Set(rows.map(r => r.participant))].sort();
const tasks = [...new Set(rows.map(r => r.task_id))].sort();

console.log("=".repeat(74));
console.log("  사람 실험 분석 — 이 스크립트는 판정하지 않는다");
console.log("=".repeat(74));
console.log(`\n참가자 ${participants.length}명 · 과제 ${tasks.length}개 · 시도 ${rows.length}회`);
console.log(`기간(시도 기준) ${Math.min(...rows.map(r => r.attempt_no))}~${Math.max(...rows.map(r => r.attempt_no))}회 반복`);

if (participants.length < MIN_N) {
  console.log(`\n⚠ 참가자 ${participants.length}명. 절차서가 정한 최소 ${MIN_N}명에 미달한다.`);
  console.log("  아래 수치를 결론으로 쓰면 안 된다 — 수집을 더 하거나 설계를 바꿔야 한다.");
}
if (tasks.length < 30) {
  console.log(`\n⚠ 과제가 ${tasks.length}개다. TASKS.md 는 30개를 정의한다. 아직 전부 돌지 않았다.`);
}
if (problems.length) {
  console.log("\n⚠ 기록에 모순이 있다 (분석은 계속하되 먼저 고쳐야 한다):");
  for (const p of problems) console.log(`  - ${p}`);
}

// ── 팔별 정확률 ───────────────────────────────────────────────────────────

console.log(`\n${"=".repeat(74)}`);
console.log("  팔별 정확률 (기계 채점)");
console.log("=".repeat(74));
console.log("\n  팔    시도   정확     95% 신뢰구간");
console.log(`  ${"-".repeat(52)}`);
/** A/B 가 무엇인지 표에 적는다 — 팔만 보여주면 읽는 사람이 무슨 비교인지 모른다 */
console.log(`  ${ARM_KEYS.map(a => `${a} = ${ARMS[a]}`).join("  ·  ")}`);

const byArm = {};
for (const arm of ARM_KEYS) {
  const rs = rows.filter(r => r.arm === arm);
  if (rs.length === 0) continue;
  const ok = rs.filter(r => r.correct === 1).length;
  const ci = rs.length >= MIN_N ? wilson(ok, rs.length) : { lo: NaN, hi: NaN };
  byArm[arm] = { n: rs.length, ok, rate: ok / rs.length, ci };
  const ciText = rs.length >= MIN_N ? `[${pct(ci.lo)}, ${pct(ci.hi)}]` : `n<${MIN_N} — 구간을 내지 않는다`;
  console.log(`  ${arm}   ${String(rs.length).padStart(4)}   ${pct(ok / rs.length).padStart(6)}   ${ciText}`);
}

// ── 쌍 분석 ───────────────────────────────────────────────────────────────

const paired = pairedAccuracyCI(rows);
console.log(`\n${"=".repeat(74)}`);
console.log("  쌍 분석 (같은 참가자 · 같은 과제 · 같은 반복에서 뺀 값)");
console.log("=".repeat(74));
if (paired.n < MIN_N) {
  console.log(`\n  짝이 ${paired.n}개뿐이다. 최소 ${MIN_N}개에 못 미치므로 구간을 내지 않는다.`);
  console.log("  두 팔을 같은 참가자가 같은 순서로 봤는지를 먼저 확인해야 한다.");
} else {
  console.log(`\n  짝 ${paired.n}개 (짝이 안 맞은 기록 ${paired.unmatched}건은 제외)`);
  console.log(`  B − A 정확률 차이 ${pct(paired.diff)}  95% 부트스트랩 구간 [${pct(paired.lo)}, ${pct(paired.hi)}]`);
  const crossesZero = paired.lo <= 0 && paired.hi >= 0;
  console.log(`  구간이 0 을 포함한다: ${crossesZero ? "예 — 이 표본으로는 차이의 방향을 말할 수 없다" : "아니오"}`);
  console.log("  (이것은 유의성 검정이 아니다. 표본 크기로는 할 수 없다.)");
}

// ── 시도 횟수 / 확인 시간 ─────────────────────────────────────────────────

console.log(`\n${"=".repeat(74)}`);
console.log("  사람이 매긴 것 (분포를 본다 — 평균을 쓰지 않는다)");
console.log("=".repeat(74));
console.log("\n  팔    시도횟수  중앙값    p90   |  확인초  중앙값    p90");
console.log(`  ${"-".repeat(62)}`);
for (const arm of ARM_KEYS) {
  const rs = rows.filter(r => r.arm === arm && Number.isFinite(r.attempts) && r.attempts > 0);
  if (rs.length === 0) continue;
  const att = rs.map(r => r.attempts);
  const tim = rs.map(r => r.verify_seconds).filter(v => Number.isFinite(v) && v > 0);
  /** 소수점 넉넉하게 남기면 111.89999999999999 같은 값이 보인다. 사람이 읽는 자리다. */
  const num = (v, digits = 0) => Number.isFinite(v) ? v.toFixed(digits) : "—";
  console.log(
    `  ${arm}    ${String(rs.length).padStart(6)}  ${num(median(att))}  ${num(quantile(att, 0.9))}   |  ` +
    `${String(tim.length).padStart(6)}  ${num(median(tim))}  ${num(quantile(tim, 0.9))}`,
  );
}
console.log("\n  평균을 쓰지 않는 이유: 확인 시간에서 3명이 5분씩 멈춰 서 있었다면");
console.log("  평균은 그 3명에 지배된다. 중앙값과 p90 이 그 사실을 드러낸다.");

// ── 거짓말 두 종류 (정확률과 분리) ────────────────────────────────────────

console.log(`\n${"=".repeat(74)}`);
console.log("  오답보다 무거운 실패 — 따로 센다");
console.log("=".repeat(74));
console.log("\n  맞는 값을 주되 그 근거가 거짓인 경우, 사람은 '맞았다'고 믿고 넘어간다.");
console.log("  그러니 이건 단순 오답이 아니라 도구의 존재 이유를 무너뜨리는 실패다.\n");
console.log("  코드                    설명                          A      B");
console.log(`  ${"-".repeat(66)}`);
const heavy = [
  ["fabricated_evidence", "근거가 원문 그 값을 가리키지 않음"],
  ["silent_loss",         "빠진 대상에 대한 사유가 없음"],
  ["refused_wrongly",      "답할 수 있는데 거절함"],
];
for (const [code, desc] of heavy) {
  const a = rows.filter(r => r.arm === ARM_KEYS[0] && r.wrong_kind === code).length;
  const b = rows.filter(r => r.arm === ARM_KEYS[1] && r.wrong_kind === code).length;
  console.log(`  ${code.padEnd(22)} ${desc.padEnd(28)} ${String(a).padStart(5)}  ${String(b).padStart(5)}`);
}

// ── 오답 유형 분포 ────────────────────────────────────────────────────────

console.log(`\n${"=".repeat(74)}`);
console.log("  오답 유형 분포")
console.log("=".repeat(74));
const kinds = [...new Set(rows.map(r => r.wrong_kind))].sort();
console.log("\n  코드                  전체    A      B");
console.log(`  ${"-".repeat(40)}`);
for (const k of kinds) {
  const all = rows.filter(r => r.wrong_kind === k).length;
  const a = rows.filter(r => r.arm === ARM_KEYS[0] && r.wrong_kind === k).length;
  const b = rows.filter(r => r.arm === ARM_KEYS[1] && r.wrong_kind === k).length;
  console.log(`  ${k.padEnd(20)} ${String(all).padStart(5)}  ${String(a).padStart(5)}  ${String(b).padStart(5)}`);
}

// ── 이탈 / 부작용 ─────────────────────────────────────────────────────────

const dropouts = [...new Set(rows.filter(r => r.gave_up === "Y").map(r => r.participant))];
console.log(`\n${"=".repeat(74)}`);
console.log("  이탈과 부작용");
console.log("=".repeat(74));
console.log(`\n  포기 기록이 있는 참가자: ${dropouts.length === 0 ? "없음" : dropouts.join(", ")}`);
if (dropouts.length > 0) {
  console.log("  이 사람의 시도는 편향을 만든다. 분석에서 뺄지 남길지 **사전에 정한 규칙**으로 처리한다.");
  console.log("  지금 정하지 않고 결과 본 뒤에 정하면 그때 보고 싶은 쪽으로 정하게 된다.");
}
const reasons = rows.filter(r => r.gave_up === "Y" && r.reason);
if (reasons.length) {
  console.log("\n  포기 이유 (그 한 줄이 다음 버전의 요구사항이다):");
  for (const r of reasons) console.log(`    ${r.run_id}: ${r.reason}`);
}

// ── 채운 사람의 수 ────────────────────────────────────────────────────────

console.log(`\n${"=".repeat(74)}`);
console.log("  채워진 범위 — 무엇을 아직 모르는지 먼저 밝힌다");
console.log("=".repeat(74));
const expectedTasks = 30;
console.log(`\n  과제     ${tasks.length} / ${expectedTasks}`);
console.log(`  참가자   ${participants.length} / 5~8`);
console.log(`  시도     ${rows.length}회`);
const armsBoth = participants.filter(p => {
  const a = new Set(rows.filter(r => r.participant === p && r.arm === "A").map(r => r.task_id));
  const b = new Set(rows.filter(r => r.participant === p && r.arm === "B").map(r => r.task_id));
  return a.size > 0 && b.size > 0;
}).length;
console.log(`  두 팔을 모두 본 참가자 ${armsBoth}명 (쌍 분석에 쓰일 수 있는 사람)`);

if (tasks.length < expectedTasks || participants.length < MIN_N) {
  console.log("\n  아직 다 모이지 않았다. 위 숫자를 결론으로 인용하지 말 것.");
}
console.log(`\n${"=".repeat(74)}`);
console.log("  판정은 하지 않는다. 위 숫자를 읽고 사람이 판단한다.");
console.log("  방법: PROCEDURE.md 10장 — 세 가지 결과 중 어느 쪽이든 publication 은 아니다.");
console.log(`${"=".repeat(74)}\n`);
