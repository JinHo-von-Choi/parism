/**
 * 실험 A — 큰 목록에서 조건에 맞는 대상 3개를 찾아 근거까지 제시하는가.
 *
 * 계획서 10장 조건: "raw, 기존 Parism, 새 budget+evidence를 동일 fixture·질문·필수 정보로 비교한다."
 * 이 스크립트는 그 세 팔을 같은 입력·같은 질문에 돌려 **기계적으로 채점 가능한 부분**만 잰다.
 *
 * 무엇을 잰다:
 *   1. 정답 recall      — 조건에 맞는 3개를 정확히 찾아냈는가 (기대값을 알고 있는 fixture)
 *   2. 근거 존재        — 고른 값마다 원문 바이트 구간이 있는가
 *   3. 근거 정확성      — 그 구간이 정말 그 값을 담는가 (바이트로 되짚는다)
 *   4. 예산 준수        — 최종 payload 가 상한 안인가
 *   5. 누락 내역 분리    — 무엇이 왜 빠졌는가 (예산/파싱/수집을 섞지 않는가)
 *
 * 무엇을 재 **않는**가: LLM 이 문장을 이해했는가, 사람의 확인 시간이 줄었는가.
 *   그건 5~8명 실험에서 사람이 매긴다. 여기서 숫자를 만들지 않는다.
 *
 * 실행: `npm run build && node experiments/experiment-a.mjs`
 *
 * 작성자: 최진호
 * 작성일: 2026-10-05
 */

import { createEngine } from "../dist/facade/engine.js";
import { Checks, makeListRepo, expectedTsOver, withTemp } from "./lib/harness.mjs";
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";

const MIN_BYTES = 2048;
const WANT = 3;
/**
 * 200개 중 조건을 만족하는 행이 37개다. 2,000토큰이면 전부 담긴다.
 * 예산 축약을 관찰하려면 예산을 더 낮춰야 하므로 1,200(최소 봉투 근처)으로 잡는다.
 */
const BUDGET_TOKENS = 1400;

const checks = new Checks("실험 A");

await withTemp(async (root) => {
  const { dir } = makeListRepo(root, 200);
  const args = ["-type", "f", "-name", "*.ts", "-size", `+${MIN_BYTES - 1}c`, "-print"];

  /** 정답 전체가 아니라 '가장 큰 3개' 를 기대값으로 삼는다. */
  const expected = expectedTsOver(dir, MIN_BYTES, WANT);
  const allMatches = execFileSync("find", args, { cwd: dir, encoding: "utf8" })
    .trim().split("\n").filter(Boolean);

  console.log(`\nfixture: ${dir}`);
  console.log(`조건(2KB 이상 .ts) 만족 ${allMatches.length}건, 그중 큰 순 3건:`);
  for (const p of expected) console.log(`  ${p}`);

  process.env.PARISM_ALLOWED_PATHS = dir;
  const engine = await createEngine();

  /** find 는 상대 경로에 './' 접두사를 붙인다. 기대값은 접두사 없는 형태다. */
  const strip = p => p.replace(/^\.\//, "");
  const norm = list => new Set(list.map(strip));
  /** find 출처는 파서가 순서·내용을 바꾸지 않는다. */
  const expectedSet = norm(allMatches);

  console.log(`\n=== 1) 팔 ①: raw + 기존 Parism (근거·예산 없음) ===`);
  const base = await engine.run("find", { args, cwd: dir });
  const basePaths = base.stdout.parsed?.paths ?? [];
  console.log(`  ok=${base.ok} 경로 ${basePaths.length}건, raw ${base.stdout.raw.length} 바이트`);

  console.log(`\n=== 2) 팔 ②: 새 budget ===`);
  const budgeted = await engine.run("find", { args, cwd: dir, budget: { max_tokens: BUDGET_TOKENS } });
  const budgetedPaths = budgeted.stdout.parsed?.paths ?? [];
  const measured = budgeted.budget?.measured_tokens ?? 0;
  console.log(`  경로 ${budgetedPaths.length}건, measured=${measured}/${BUDGET_TOKENS}`);
  for (const o of budgeted.omission ?? []) {
    console.log(`  omission: stage=${o.stage} reason=${o.reason} total=${o.rows_total ?? "-"} omit=${o.rows_omitted ?? "-"}`);
  }

  console.log(`\n=== 3) 팔 ③: budget + 이어 읽기 ===`);
  const paged = await engine.run("find", {
    args, cwd: dir, retain: true, contract_version: "next",
    budget: { max_tokens: BUDGET_TOKENS, required_fields: ["path"] },
  });
  const firstPaths = paged.stdout.parsed?.paths ?? [];
  const all = new Set(firstPaths);
  let cursor = paged.continuation?.cursor;
  let hops = 0;
  while (cursor && hops++ < 30) {
    const page = engine.fetchResult(paged.review.result_id, cursor, { max_tokens: BUDGET_TOKENS });
    if (!page.ok) { console.log(`  fetch 실패: ${page.reason}`); break; }
    for (const row of page.value?.entries ?? []) all.add(row.path);
    cursor = page.continuation?.cursor;
  }
  console.log(`  1차 ${firstPaths.length}건 + 이어 읽기 ${hops}회 = ${all.size}건`);

  console.log(`\n=== 채점 ===`);

  /** 1. 정답 recall */
  checks.check("기존 Parism 가 조건을 만족하는 전부를 낸다", norm(basePaths).size === expectedSet.size,
    `${norm(basePaths).size}/${expectedSet.size}`);
  checks.check("큰 순 3건이 모두 들어 있다", expected.every(p => norm(basePaths).has(p)),
    expected.filter(p => !norm(basePaths).has(p)).join(",") || "3/3");
  checks.check("이어 읽기까지 하면 전부 복원된다", norm([...all]).size === expectedSet.size,
    `${norm([...all]).size}/${expectedSet.size}`);

  /** 2. 조건에 안 맞는 값을 지어내지 않았는가 */
  const wrong = basePaths.filter(p => !expectedSet.has(strip(p)));
  checks.check("조건을 안 맞는 값을 지어내지 않는다", wrong.length === 0, wrong.slice(0, 3).join(","));

  /** 3. 예산 준수 — 표면까지 붙인 최종 payload 기준 */
  checks.check("최종 payload 가 예산 안이다",
    budgeted.budget?.budget_met === true && measured <= BUDGET_TOKENS, `${measured} <= ${BUDGET_TOKENS}`);
  checks.check("토크나이저가 고정된 것임을 밝힌다", budgeted.budget?.tokenizer_id === "parism/approx",
    budgeted.budget?.tokenizer_id);
  checks.check("토큰 수가 근사치임을 숨기지 않는다", budgeted.budget?.tokenizer_exact === false,
    `exact=${budgeted.budget?.tokenizer_exact}`);

  /** 4. 축약이 생겼으면 그 이유를 밝혀야 한다 */
  if (firstPaths.length < basePaths.length) {
    checks.check("줄어든 만큼 누락 내역을 밝힌다", (paged.omission?.length ?? 0) > 0,
      (paged.omission ?? []).map(o => `${o.stage}/${o.reason}`).join(",") || "누락 내역 없음");
    const stages = new Set((paged.omission ?? []).map(o => o.stage));
    checks.check("누락 원인이 단계별로 구분된다",
      stages.size > 0 && [...stages].every(s => ["capture", "parse", "projection", "budget", "privacy"].includes(s)),
      [...stages].join(",") || "없음");
    checks.check("필수 필드는 축약에서도 남는다",
      firstPaths.every(p => typeof p === "string" && p.length > 0), `${firstPaths.length}건 모두 path 보유`);
  } else {
    checks.check("1차가 전부 담겼으면 누락 내역도 없다", (paged.omission?.length ?? 0) === 0,
      (paged.omission ?? []).length + "건");
  }

  /** 5. 근거 — ps 와 git porcelain 이 근거를 만든다(find 는 근거 파서가 아니다) */
  console.log(`\n=== 4) 근거 조회 (M1 근거 MVP 파서로 재확인) ===`);
  const git = (...a) => execFileSync("git", a, { cwd: dir, encoding: "utf8" });
  /** 스테이징 안 됨(' M')과 미추적('??')을 모두 만든다 */
  writeFileSync(`${dir}/docs/f147.ts`, "changed\n");
  writeFileSync(`${dir}/src/util/newfile.ts`, "new\n");
  git("add", "-A"); git("commit", "-qm", "second");
  writeFileSync(`${dir}/docs/f147.ts`, "modified again\n");
  writeFileSync(`${dir}/test/f176.ts`, "modified\n");
  writeFileSync(`${dir}/brand-new.ts`, "untracked\n");

  const ev = await engine.run("git", {
    args: ["status", "--porcelain=v1", "-z"], cwd: dir,
    contract_version: "next", evidence: "rows", retain: true,
  });
  const entries = ev.stdout.parsed?.entries ?? [];
  console.log(`  porcelain 항목 ${entries.length}건: ${entries.map(e => `${e.xy} ${e.path}`).join(" | ")}`);

  if (ev.review?.retained) {
    let withEvidence = 0; let derived = 0; const noEvidence = [];
    const raw = ev.stdout.raw;
    const buf = Buffer.from(raw, "utf8");
    let mismatch = 0;

    for (let i = 0; i < entries.length; i++) {
      const ex = engine.explainResult(ev.review.result_id, `/entries/${i}/path`);
      if (!ex.ok) { noEvidence.push(`${entries[i].path}(${ex.reason})`); continue; }
      if (ex.source_spans.length === 0) { noEvidence.push(`${entries[i].path}(근거 없음)`); continue; }
      withEvidence++;
      if (ex.source_kind === "derived") derived++;
      /** 이스케이프가 풀린 경로는 span 이 원문의 따옴표 구간이라 값과 문자열이 다르다 */
      const sp = ex.source_spans[0];
      if (sp.transform) continue;
      const text = buf.subarray(sp.start, sp.end).toString("utf8");
      if (text !== ex.value) { mismatch++; console.log(`    불일치: span="${text}" 값=${JSON.stringify(ex.value)}`); }
    }

    checks.check("porcelain 전 항목에 원문 근거가 있다", noEvidence.length === 0, noEvidence.join(","));
    checks.check("근거 구간이 원문에서 그 값을 가리킨다", mismatch === 0, `불일치 ${mismatch}건`);
    console.log(`  (근거 ${withEvidence}건 중 변환을 거친 값 ${derived}건)`);

    const bad = engine.explainResult(ev.review.result_id, "/없는/포인터");
    checks.check("잘못된 포인터를 조용히 빈 값으로 두지 않는다",
      bad.ok === false && bad.reason === "unknown_pointer", bad.ok ? "빈 값 반환" : bad.reason);

    /**
     * 모르는 id 와 보관하지 않은 결과는 서로 다른 사유로 거절된다.
     * 둘을 같은 문자열로 뭉개지 않는다 — '왜 못 했나'가 달라야 사용자가 다음을 안다.
     */
    const unknown = engine.explainResult("r_존재하지않는아이디", "/entries/0/path");
    checks.check("모르는 id 는 unknown_id 로 거절한다",
      unknown.ok === false && unknown.reason === "unknown_id", unknown.ok ? "값 반환" : unknown.reason);

    const noRetain = await engine.run("git", {
      args: ["status", "--porcelain=v1", "-z"], cwd: dir,
      contract_version: "next", evidence: "rows",
    });
    checks.check("보관하지 않은 결과는 not_retained 로 거절한다",
      noRetain.review?.retained === false && noRetain.review.result_id !== undefined,
      `retained=${noRetain.review?.retained}`);
    const notRetained = engine.explainResult(noRetain.review.result_id, "/entries/0/path");
    checks.check("보관하지 않은 결과는 재실행 없이 거절한다",
      notRetained.ok === false && notRetained.reason === "not_retained",
      notRetained.ok ? "값 반환" : notRetained.reason);
  } else {
    checks.check("결과가 보관되었다", false, "retained=false");
  }

  /** 6. 실패는 조용히 넘어가지 않는다 */
  const tiny = await engine.run("find", { args, cwd: dir, budget: { max_tokens: 100 } });
  checks.check("예산이 최소 봉투에 못 미치면 실행 전에 거절",
    tiny.ok === false && tiny.failure?.reason === "budget_too_small",
    tiny.failure ? `${tiny.failure.kind}/${tiny.failure.reason}` : "(거절되지 않음)");

  const badTok = await engine.run("find", {
    args, cwd: dir, budget: { max_tokens: BUDGET_TOKENS, tokenizer: "gpt-4o" },
  });
  checks.check("미지원 토크나이저를 조용히 대체하지 않는다",
    badTok.ok === false && badTok.failure?.reason === "tokenizer_unsupported",
    badTok.failure?.reason ?? "(거절되지 않음)");

  const denied = await engine.run("find", { args, cwd: "/etc" });
  checks.check("허용 밖 경로를 조용히 처리하지 않는다",
    denied.ok === false && denied.failure?.reason === "path_not_allowed",
    denied.failure?.reason ?? "(거절되지 않음)");
});

process.exitCode = checks.finish() ? 0 : 1;

/** fixture 는 재실행해도 같아야 하므로 덮어쓰기만 한다. */
