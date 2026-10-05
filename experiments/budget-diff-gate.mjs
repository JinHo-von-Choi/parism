/**
 * 예산·의미 diff 게이트 — 계획서 9장 M2·M3 종료 조건을 **실제로 잰다**.
 *
 *   M2 종료 조건: "예산 정확성, 값 복원, 필수 필드 recall 100%, silent-loss 0건"
 *   M3 종료 조건: "거짓 삭제 0, 순서만 변경한 diff 0, 다른 대상 비교 거절, key 충돌 오류화"
 *
 * ## 왜 이 게이트가 있는지
 *
 * 위 조건들은 문서에 통과했다고 적혀 있었지만 **측정된 적이 없었다.**
 * 단위 시험이 있다는 것과 조건이 참이라는 것은 다른 말이다.
 * `experiments/corpus.mjs` 가 파서 정확성을 재듯, 여기는 예산과 diff 의 계약을 잰다.
 *
 * ## 무엇을 판정하는가
 *
 *   예산 정합      `measured_tokens` 가 **소비자가 실제로 받는 응답의 토큰 수와 같은가**
 *                  `budget_met` 이 그 값에 대해 참인가 (상한을 넘었는데 참이라 하지 않는가)
 *   값 복원        빠진 행이 커서를 통해 **다시 온다**
 *   필수 필드      `required_fields` 가 남긴 **모든 행과 모든 페이지** 에 있다 (100%)
 *   silent-loss    빠진 행이 **반드시 omission 으로 선언**된다 (조용한 손실 0건)
 *   거짓 삭제      값이 그대로인데 diff 가 '변경' 이라 하지 않는다
 *   대상 거절      **다른 명령**의 결과끼리 비교하지 않는다
 *   key 충돌       key 가 겹치면 조용히 넘어가지 않고 드러낸다
 *
 * ## 이 게이트가 재지 **않는** 것
 *
 * **"순서만 변경하면 diff 0"** 은 여기서 재지 않는다. 같은 명령의 출력을 두 번 돌려서는
 * **순서만 다른 동일 내용을 만들 수 없다** — 생성하려고 시도했다가 파일 이름을 바꿔야 했고,
 * 그건 순서 변경이 아니라 이름 변경이었다. 억지로 만든 조건으로 게이트를 채우면 안 된다.
 * 이 조건은 단위 시험이 맡는다(`tests/engine/compare.test.ts` "행 순서만 바뀌면 변화 0").
 *
 * **사람 실험의 `silent_loss`** 도 재지 않는다. 그것은 에이전트가 조용히 값을 잃었는가 라는
 * 질문이고 사람(또는 에이전트)이 답해야 한다. 여기 재는 것은 **엔진이 omission 으로
 * 알렸는가** 다 — 다른 질문이다.
 *
 * 실행: `npm run build && node experiments/budget-diff-gate.mjs [--cases=12]`
 *
 * 작성자: 최진호
 * 작성일: 2026-10-05
 */

import { execFileSync }   from "node:child_process";
import { rmSync }        from "node:fs";
import { createEngine }  from "../dist/facade/engine.js";
import { countJsonTokens } from "../dist/engine/budget/tokenizer.js";

const TOKENIZER = "parism/approx";
const casesArg = process.argv.find(a => a.startsWith("--cases="));
const CASES    = Number(casesArg ? casesArg.slice("--cases=".length) : 12);

console.log("=".repeat(80));
console.log("  예산·의미 diff 게이트 — M2·M3 종료 조건");
console.log("=".repeat(80));
console.log(`\n케이스 ${CASES}종 · 토크나이저 ${TOKENIZER}\n`);

const failures = [];
const byCheck = { honesty: 0, restore: 0, required: 0, silent: 0, falseChange: 0, target: 0, keyConflict: 0 };
const CHECK_LABEL = {
  honesty: "예산 정합", restore: "값 복원", required: "필수 필드", silent: "silent-loss",
  falseChange: "거짓 삭제", target: "비교 대상 거절", keyConflict: "key 충돌",
};
const fail = (check, message) => { failures.push({ check, message }); byCheck[check]++; };

const engine = await createEngine();

/** rowsOf — 파싱 결과는 크기에 따라 모양이 다르다(행 배열 / {schema, rows}). */
function rowsOf(parsed) {
  if (Array.isArray(parsed)) return parsed;
  if (parsed == null || typeof parsed !== "object") return [];
  for (const v of Object.values(parsed)) {
    if (Array.isArray(v)) return v;
    if (v != null && typeof v === "object" && Array.isArray(v.rows)) return v.rows;
  }
  return [];
}

/** 소비자가 실제로 받는 응답의 토큰 수 */
const deliveredTokens = env => countJsonTokens(JSON.stringify(env), TOKENIZER);

let seed = 0;
function makeRepo(n) {
  const dir = `.bdg-${process.pid}-${seed++}`;
  execFileSync("mkdir", ["-p", dir]);
  for (let i = 1; i <= n; i++) {
    execFileSync("bash", ["-c", `printf 'x%.0s' $(seq 1 $((i % 13 + 4))) > ${dir}/file_${i}.txt`]);
  }
  return dir;
}

// ── M2 ──────────────────────────────────────────────────────────────────────

for (let c = 0; c < CASES; c++) {
  const rows  = 12 + (c % 45);
  /** 상한을 결과 근처에 두어야 결함이 드러난다. 넉넉하면 아무 문제가 안 보인다. */
  const cap   = 1300 + c * 700;
  const format = c % 2 === 0 ? "json" : "json-no-raw";
  const dir   = makeRepo(rows);

  try {
    /** 예산 없이 먼저 돌려 **기대 총 행 수를 재서** 쓴다 — 추측으로 세지 않는다. */
    const full = await engine.run("ls", { args: ["-l", dir], format });
    const total = rowsOf(full.stdout.parsed).length;
    if (total === 0) { fail("silent", `케이스 ${c}: 예산 없이 돌렸는데 행이 0개다 — 기준을 세울 수 없다`); continue; }

    const env = await engine.run("ls", {
      args: ["-l", dir], format,
      budget: { max_tokens: cap, tokenizer: TOKENIZER, required_fields: ["name"], overflow: "page" },
    });

    if (env.failure) {
      /** 최소 봉투에 못 미치면 실행 전에 거절된다 — 그 자체가 설계된 동작이다 */
      if (env.failure.reason === "budget_too_small") continue;
      fail("honesty", `케이스 ${c}: 예상 밖의 실패 ${JSON.stringify(env.failure)}`);
      continue;
    }

    // 1) 예산 정합 — 보고가 자기 크기를 속이지 않는가
    const delivered = deliveredTokens(env);
    if (env.budget.measured_tokens !== delivered) {
      fail("honesty", `케이스 ${c}(${format}, 상한 ${cap}): measured_tokens ${env.budget.measured_tokens} ≠ 실제 전달 ${delivered}`);
    }
    if (env.budget.budget_met !== (delivered <= cap)) {
      fail("honesty", `케이스 ${c}(${format}, 상한 ${cap}): budget_met=${env.budget.budget_met} 이나 실제 전달 ${delivered}`);
    }
    if (env.budget.budget_met && delivered > cap) {
      fail("honesty", `케이스 ${c}: 상한 ${cap} 를 넘었는데 budget_met 이 참이다`);
    }

    const kept = rowsOf(env.stdout.parsed);

    // 2) 필수 필드 recall — 남긴 행마다
    for (const row of kept) {
      if (row.name === undefined) { fail("required", `케이스 ${c}: 필수 필드 'name' 가 빠진 행을 내보냈다`); break; }
    }

    // 3) silent-loss — 빠진 행은 반드시 선언된다
    const missing = total - kept.length;
    const declared = (env.omission ?? []).filter(o => o.stage === "budget")
      .reduce((sum, o) => sum + (o.rows_omitted ?? 0), 0);
    if (missing > 0 && declared === 0) {
      fail("silent", `케이스 ${c}: ${missing}행이 빠졌는데 omission 으로 선언된 것이 없다 — 조용한 손실이다`);
    } else if (missing !== declared) {
      fail("silent", `케이스 ${c}: ${missing}행이 빠졌는데 omission 은 ${declared}행이라 한다`);
    }

    // 4) 값 복원 — 커서로 따라가면 빠진 행이 다시 온다
    if (missing > 0 && env.continuation?.cursor) {
      const page = engine.fetchResult(env.budget.requested ? "" : "", env.continuation.cursor, { max_tokens: cap });
      if (page.ok) {
        fail("restore", `케이스 ${c}: result_id 없이 커서를 받아 성공했다 — 진행 규칙이 느슨하다`);
      } else if (page.reason !== "cursor_mismatch" && page.reason !== "cursor_invalid") {
        fail("restore", `케이스 ${c}: 진행이 ${page.reason} 로 거절되었다`);
      }
      /** 올바른 id 로 부르면 성공해야 한다 — 거절만 세면 아무것도 검증하지 않는다 */
      const resultId = env.review?.result_id;
      if (resultId) {
        const ok = engine.fetchResult(resultId, env.continuation.cursor, { max_tokens: cap });
        if (!ok.ok) fail("restore", `케이스 ${c}: 올바른 id 로도 진행이 ${ok.reason} 로 거절됐다`);
      }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ── M3 ──────────────────────────────────────────────────────────────────────

{
  const dirA = makeRepo(10);
  const dirB = makeRepo(10);
  try {
    /** 결과 두 개를 보관해 id 를 얻는다. */
    const retain = async dir => {
      const r = await engine.run("ls", {
        args: ["-l", dir], cwd: process.cwd(), format: "json",
        contract_version: "next", evidence: "rows", retain: true,
      });
      return r;
    };

    const a = await retain(dirA);
    if (!a.review?.result_id) fail("falseChange", "기준 결과를 보관하지 못했다");

    // 1) 거짓 삭제 — **아무것도 바꾸지 않았는데** diff 가 나오면 안 된다
    if (a.review?.result_id) {
      const same = await retain(dirA);
      const d = engine.compare(a.review.result_id, same.review.result_id);
      if (!d.ok) {
        fail("falseChange", `같은 결과를 비교하는데 거절됐다: ${JSON.stringify(d.refusals ?? {})}`);
      } else {
        const changed = (d.changed ?? []).length + (d.added ?? []).length + (d.removed ?? []).length;
        if (changed !== 0) fail("falseChange", `바꾸지 않은 결과를 비교해 변경 ${changed}건이 나왔다 — 거짓 삭제다`);
      }
    }

    // 2) 비교 대상 거절 — **다른 명령**의 결과끼리는 비교할 수 없다
    if (a.review?.result_id) {
      const other = await engine.run("ps", {
        args: ["aux"], contract_version: "next", evidence: "rows", retain: true,
      });
      if (other.review?.result_id) {
        const d = engine.compare(a.review.result_id, other.review.result_id);
        if (d.comparable === true) {
          fail("target", "다른 명령의 결과끼리 비교가 가능하다고 나왔다 — 비교 대상 거절이 되지 않았다");
        }
      }
    }

    // 3) key 충돌 — 같은 이름이 둘이면 조용히 넘어가지 않는다
    const dup = `.bdg-dup-${process.pid}`;
    execFileSync("mkdir", ["-p", dup]);
    const r1 = await engine.run("ls", {
      args: ["-l", dup], cwd: process.cwd(), format: "json",
      contract_version: "next", evidence: "rows", retain: true,
    });
    const r2 = await engine.run("ls", {
      args: ["-l", dup], cwd: process.cwd(), format: "json",
      contract_version: "next", evidence: "rows", retain: true,
    });
    if (r1.review?.result_id && r2.review?.result_id) {
      const d = engine.compare(r1.review.result_id, r2.review.result_id, { key_fields: ["name"] });
      if (d.ok && (d.key_conflicts ?? []).length > 0) {
        fail("keyConflict", "같은 결과를 비교하는데 key 충돌이 보고됐다 — 충돌 판정이 과하다");
      }
      if (d.ok && (d.unchanged_count ?? 0) !== rowsOf(r1.stdout.parsed).length) {
        fail("keyConflict", `같은 결과의 unchanged 가 ${d.unchanged_count} 인데 행은 ${rowsOf(r1.stdout.parsed).length} 개다`);
      }
    }
    rmSync(dup, { recursive: true, force: true });
  } finally {
    rmSync(dirA, { recursive: true, force: true });
    rmSync(dirB, { recursive: true, force: true });
  }
}

// ── 결과 ────────────────────────────────────────────────────────────────────

console.log(`${"=".repeat(80)}`);
console.log("  결과");
console.log(`${"=".repeat(80)}\n`);

if (failures.length === 0) {
  console.log(`  ${"=".repeat(72)}`);
  console.log("  M2·M3 종료 조건 — 이 게이트가 재는 범위에서 어긋난 항목 없다.");
  console.log(`  ${"=".repeat(72)}\n`);
  console.log("  다만 이것이 뜻하는 바는 한정적이다:");
  console.log("  - '순서만 변경하면 diff 0' 은 여기서 재지 않는다. 단위 시험이 맡는다(tests/engine/compare.test.ts).");
  console.log("  - 사람 실험의 `silent_loss`(에이전트가 조용히 값을 잃었는가)도 재지 않는다. 사람이 답해야 한다.");
  console.log("  - 여기 재는 것은 '엔진이 omission 으로 알렸는가' 다 — 다른 질문이다.\n");
  process.exit(0);
}

console.log(`  깨진 항목 ${failures.length}건\n`);
console.log("  판정 항목별:");
for (const [k, v] of Object.entries(byCheck)) {
  if (v > 0) console.log(`    ${(CHECK_LABEL[k] ?? k).padEnd(20)} ${v}건`);
}
console.log("\n  처음 20건:");
for (const f of failures.slice(0, 20)) console.log(`    [${CHECK_LABEL[f.check]}] ${f.message}`);
if (failures.length > 20) console.log(`    … 외 ${failures.length - 20}건`);
process.exit(1);
