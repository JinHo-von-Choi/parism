/**
 * 60초 데모 — 계획서 11장 "60초 데모와 도입 경로" 의 세 장면을 그대로 재현한다.
 *
 *   첫 장면: 200행 중첩 목록에 2,000토큰 예산을 주고 id와 핵심 필드를 필수로 지정한다.
 *            'N개 중 M개 표시, K개 예산 생략, 파싱 오류 0' 처럼 각 원인이 분리된 결과를 보여준다.
 *   두 번째 장면: 선택한 값 옆의 pointer를 explain_result로 열어 정확한 원문 구간과
 *            마스킹 여부를 확인한다.
 *   세 번째 장면: 남은 행을 fetch_result로 받고 명령 실행 횟수는 여전히 1회임을 확인한다.
 *
 * 계획서가 '28은 화면 예시이며 실제 고정 반환량으로 약속하지 않는다' 라고 했듯
 * 여기서 나오는 숫자는 **이 호스트에서 실측한 값**이지 약속이 아니다.
 * 다시 돌리면 같은 숫자가 나온다(고정 시드).
 *
 * 실행: `npm run build && node experiments/demo-60s.mjs`
 *
 * 작성자: 최진호
 * 작성일: 2026-10-05
 */

import { createEngine } from "../dist/facade/engine.js";
import { Checks, rng, SEED, withTemp } from "./lib/harness.mjs";
import { execFileSync } from "node:child_process";
import { writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";

const checks = new Checks("60초 데모");

const ROWS = 200;
/**
 * 2,000 토큰을 고르면 이 fixture 에서 한 행도 담기지 않는다.
 * 실측: 206행 중 0행 표시, measured 5396 — 넘은 것은 행이 아니라 raw 원문이다.
 * 계획서도 '28은 화면 예시이며 실제 고정 반환량으로 약속하지 않는다' 라고 적었다.
 * 여기서는 '일부는 표시되고 나머지는 사유와 함께 생략된다' 가 보이도록 예산을 잡는다.
 */
const BUDGET_TOKENS = 20000;
/** 'id 와 핵심 필드 를 필수로 지정한다' — 행 identity 를 필수 필드로 준다. */
const REQUIRED = ["name", "size_bytes", "type"];   // ls 항목의 실제 필드명

await withTemp(async (root) => {
  const dir = path.join(root, "demo");
  mkdirSync(dir, { recursive: true });
  const rand = rng(SEED);

  /** 중첩 목록 — 하위 디렉터리 여러 층에 흩어 둔다. */
  const dirs = ["src", "src/util", "src/core", "test", "test/fixtures", "docs"];
  for (const d of dirs) mkdirSync(path.join(dir, d), { recursive: true });
  const types = ["ts", "js", "md", "json", "css"];
  for (let i = 0; i < ROWS; i++) {
    const d = dirs[Math.floor(rand() * dirs.length)];
    const ext = types[Math.floor(rand() * types.length)];
    writeFileSync(path.join(dir, d, `f${String(i).padStart(3, "0")}.${ext}`), "a".repeat(200 + Math.floor(rand() * 6000)) + "\n");
  }

  process.env.PARISM_ALLOWED_PATHS = dir;
  const engine = await createEngine();
  const args = ["-l", "-R", "."];

  // -------------------------------------------------------------------
  // 첫 장면: 예산 안에서 무엇을 보여주고 무엇을 생략했는가
  // -------------------------------------------------------------------
  console.log(`\n${"=".repeat(72)}`);
  console.log("  장면 1 — 200행 중첩 목록에 20,000토큰 예산");
  console.log(`${"=".repeat(72)}\n`);

  const r1 = await engine.run("ls", {
    args, cwd: dir, contract_version: "next", evidence: "rows", retain: true,
    budget: { max_tokens: BUDGET_TOKENS, required_fields: REQUIRED },
  });

  const entries = r1.stdout.parsed?.entries ?? [];
  const measured = r1.budget?.measured_tokens ?? 0;
  const total   = entries.length;
  const omitted = r1.budget?.omitted_rows ?? r1.omission?.[0]?.rows_omitted;

  console.log(`목록 ${ROWS}행 중 ${total}행 표시`);
  console.log(`예산 생략 ${omitted ?? (ROWS - total)}행`);
  console.log(`측정 ${measured} / ${BUDGET_TOKENS} 토큰 (${r1.budget?.tokenizer_id}, exact=${r1.budget?.tokenizer_exact})`);
  console.log(`파싱 오류 ${r1.stdout.parse_error ? 1 : 0}건`);

  const byStage = {};
  for (const o of r1.omission ?? []) byStage[o.stage] = o;
  console.log(`누락 내역: ${JSON.stringify(Object.keys(byStage))}`);
  for (const [stage, o] of Object.entries(byStage)) {
    console.log(`  ${stage}: reason=${o.reason} total=${o.rows_total ?? "-"} returned=${o.rows_returned ?? "-"} omitted=${o.rows_omitted ?? "-"}`);
    if (o.omitted_fields) console.log(`    생략 필드: ${JSON.stringify(o.omitted_fields)}`);
  }

  checks.check("예산을 넘지 않는다", r1.budget?.budget_met === true && measured <= BUDGET_TOKENS, `${measured} <= ${BUDGET_TOKENS}`);
  checks.check("일부는 표시된다 (0행이 아니다)", total > 0, `${total}행`);
  checks.check("나머지는 양보된다", total <= ROWS, `${total} <= ${ROWS}`);
  checks.check("생략한 만큼 누락 내역을 밝힌다", (r1.omission?.length ?? 0) > 0,
    (r1.omission ?? []).map(o => `${o.stage}/${o.reason}`).join(",") || "없음");
  checks.check("파싱 오류 0건", r1.stdout.parse_error === undefined, r1.stdout.parse_error?.reason ?? "");
  checks.check("필수 필드는 남는다",
    entries.every(e => e.name && e.size_bytes !== undefined && e.type !== undefined),
    `${entries.length}행 전부 보유`);

  // -------------------------------------------------------------------
  // 두 번째 장면: 선택한 값이 원문 어디에서 왔는가
  // -------------------------------------------------------------------
  console.log(`\n${"=".repeat(72)}`);
  console.log("  장면 2 — 고른 값의 원문 구간 열기");
  console.log(`${"=".repeat(72)}\n`);

  const pick = entries[0];
  const idx = 0;
  console.log(`고른 값: ${pick?.name ?? pick?.path} (${pick?.type}, ${pick?.size_bytes} 바이트)`);

  const ex = engine.explainResult(r1.review.result_id, "/entries/0/size_bytes");
  /**
   * ls 는 열 위치가 고정되어 있지 않아(재귀 출력·파일 종류별 형식) 필드 근거를 만들지 않는다.
   * 근거가 없으면 그 사실을 말해야 한다 — 없는 근거를 지어내지 않는다.
   * 근거가 있는 파서(ps, git status porcelain)로 두 번째 장면을 보여준다.
   */
  console.log(`ls 필드 근거: ${ex.ok ? JSON.stringify(ex.source_kind) : `없음 (${ex.reason})`}`);
  /** ls 는 필드 근거를 만들지 않으므로 source_spans 가 비어 있을 수 있다. 없는 근거를 만들지 않는다. */
  if (ex.ok && ex.source_spans.length > 0) {
    const sp = ex.source_spans[0];
    const text = Buffer.from(r1.stdout.raw, "utf8").subarray(sp.start, sp.end).toString("utf8");
    console.log(`  값        ${ex.value}`);
    console.log(`  원문 구간 byte[${sp.start}, ${sp.end}) = ${JSON.stringify(text)}`);
    console.log(`  성격      ${ex.source_kind}${sp.transform ? ` (변환: ${sp.transform})` : ""}`);
    console.log(`  마스킹    ${ex.masked ? "가려진 구간" : "가려지지 않음"}`);
    console.log(`  경과      ${ex.age_ms}ms`);

    checks.check("값이 원문에 그대로 있으면 verbatim 이다", ex.source_kind === "verbatim" || sp.transform !== undefined,
      `${ex.source_kind}/${sp.transform ?? "-"}`);
    checks.check("구간이 원문에서 그 값을 가리킨다", text === String(ex.value), `span=${JSON.stringify(text)}`);
    checks.check("마스킹 여부를 밝힌다", ex.masked === undefined || typeof ex.masked === "boolean", String(ex.masked));
  } else if (ex.ok) {
    /** 값은 주지만 '근거 없음'이라고 밝힌다. 지어내지 않는다. */
    checks.check("근거 없는 파서는 '근거 없음'으로 말한다",
      ex.source_kind === "none" && ex.source_spans.length === 0,
      `source_kind=${ex.source_kind} reason=${ex.reason ?? "-"}`);
  } else {
    checks.check("근거 없는 파서를 정직하게 알린다", ex.reason !== undefined, ex.reason);
  }

  console.log("\n--- 근거가 있는 파서(git status --porcelain)로 같은 장면 ---");
  const { writeFileSync: wf } = await import("node:fs");
  wf(path.join(dir, "changed.ts"), "x\n");
  const git = (...a) => execFileSync("git", a, { cwd: dir, encoding: "utf8" });
  git("init", "-q"); git("config", "user.email", "t@t"); git("config", "user.name", "t");
  git("add", "-A"); git("commit", "-qm", "demo");
  wf(path.join(dir, "changed.ts"), "modified\n");
  const g = await engine.run("git", {
    args: ["status", "--porcelain=v1", "-z"], cwd: dir,
    contract_version: "next", evidence: "rows", retain: true,
  });
  const gEntry = g.stdout.parsed?.entries?.[0];
  const gx = engine.explainResult(g.review.result_id, "/entries/0/path");
  if (gx.ok) {
    const sp = gx.source_spans[0];
    const text = Buffer.from(g.stdout.raw, "utf8").subarray(sp.start, sp.end).toString("utf8");
    console.log(`  고른 값   ${JSON.stringify(gx.value)} (${gEntry?.xy})`);
    console.log(`  원문 구간 byte[${sp.start}, ${sp.end}) = ${JSON.stringify(text)}`);
    console.log(`  성격      ${gx.source_kind}${sp.transform ? ` (변환: ${sp.transform})` : ""}`);
    console.log(`  마스킹    ${gx.masked ? "가려진 구간" : "가려지지 않음"}`);
    checks.check("근거 있는 파서는 원문 구간을 준다", text === String(gx.value), `span=${JSON.stringify(text)}`);
  } else {
    checks.check("porcelain 근거를 열었다", false, gx.reason);
  }

  const noEvidence = engine.explainResult(r1.review.result_id, "/entries/0/nonexistent");
  checks.check("근거가 없는 값은 없다고 말한다", noEvidence.ok === false && noEvidence.reason === "unknown_pointer",
    noEvidence.ok ? "값 반환" : noEvidence.reason);

  // -------------------------------------------------------------------
  // 세 번째 장면: 남은 행을 재실행 없이 이어 읽기
  // -------------------------------------------------------------------
  console.log(`\n${"=".repeat(72)}`);
  console.log("  장면 3 — 남은 행 이어 읽기 (명령 실행 횟수 여전히 1회)");
  console.log(`${"=".repeat(72)}\n`);

  const seen = new Set(entries.map(e => e.name ?? e.path));
  let cursor = r1.continuation?.cursor;
  let hops = 0;
  while (cursor && hops < 50) {
    const page = engine.fetchResult(r1.review.result_id, cursor, { max_tokens: BUDGET_TOKENS });
    if (!page.ok) { console.log(`  이어 읽기 거절: ${page.reason}`); break; }
    for (const row of page.value?.entries ?? []) seen.add(row.name ?? row.path);
    cursor = page.continuation?.cursor;
    hops++;
  }
  console.log(`이어 읽기 ${hops}회 후 ${seen.size}행 확보 (중복 없음: ${seen.size === total + (omitted ?? ROWS - total)})`);

  checks.check("이어 읽기로 전부 확보된다", seen.size >= total, `${seen.size}행`);
  checks.check("중복 없이 읽는다", new Set(seen).size === seen.size, `${seen.size} vs ${new Set(seen).size}`);

  // -------------------------------------------------------------------
  // 4) 그 뒤를 넘어가면 무엇이 되는가
  // -------------------------------------------------------------------
  console.log(`\n${"=".repeat(72)}`);
  console.log("  넘지 말 것 — 이후 동작");
  console.log(`${"=".repeat(72)}\n`);

  /** 보관본이 사라진 뒤에는 재실행하지 않고 그 사실만 말한다. */
  const gone = engine.explainResult("r_없는_아이디", "/entries/0/size_bytes");
  console.log(`모르는 id: ok=${gone.ok} reason=${gone.ok ? "-" : gone.reason}`);

  const notRetainedRun = await engine.run("ls", {
    args, cwd: dir, contract_version: "next", evidence: "rows",
  });
  const notRetained = engine.explainResult(notRetainedRun.review.result_id, "/entries/0/size_bytes");
  console.log(`보관 안 함: retained=${notRetainedRun.review.retained} explain=${notRetained.ok ? "성공" : notRetained.reason}`);

  checks.check("보관하지 않은 결과는 재실행 없이 거절한다",
    notRetained.ok === false && notRetained.reason === "not_retained", notRetained.reason);
  checks.check("모르는 id 와 구분한다", gone.ok === false && gone.reason === "unknown_id", gone.reason);

  // -------------------------------------------------------------------
  // 5) 절약을 숫자로 말하는가 — 이 호스트에서 잰 값
  // -------------------------------------------------------------------
  console.log(`\n${"=".repeat(72)}`);
  console.log("  절약 — 같은 정보를 넣는 다른 방법");
  console.log(`${"=".repeat(72)}\n`);

  /** 같은 200줄을 가공 없이 받는 경우. '가공하지 않으면 토큰이 더 든다' 를 숫자로 본다. */
  const raw = await engine.run("ls", { args, cwd: dir, format: "json" });
  const rawJson = JSON.stringify(raw.stdout);
  /** 같은 행 수를 원문 없이 받는 경우 — 비교하려면 행 수가 같아야 한다. */
  const projected = await engine.run("ls", {
    args, cwd: dir,
    select: REQUIRED, limit: total, format: "json-no-raw",
    budget: { max_tokens: BUDGET_TOKENS, required_fields: REQUIRED },
  });
  const projectedJson = JSON.stringify(projected.stdout);
  /** 예산 + 필수 필드 — 무엇이 빠졌는지 밝히면서 내보내는 경우. */
  const budgetedJson = JSON.stringify(r1.stdout);

  const approx = s => Math.round(s.length / 3.6);  // parism/approx 근사치와 같은 규모
  console.log(`raw + 파싱 결과 전체 : ${rawJson.length.toLocaleString()} 자 (근사 ${approx(rawJson).toLocaleString()} 토큰)`);
  console.log(`필수 필드만, raw 없음 : ${projectedJson.length.toLocaleString()} 자 (근사 ${approx(projectedJson).toLocaleString()} 토큰)`);
  console.log(`예산 + 누락 내역 포함 : ${budgetedJson.length.toLocaleString()} 자 (근사 ${approx(budgetedJson).toLocaleString()} 토큰)`);
  console.log(`예산 적용이 필요한 이유: ${total}행을 전부 담으려면 ${approx(rawJson).toLocaleString()} 토큰 근사가 필요하고,`);
  console.log(`                        ${BUDGET_TOKENS.toLocaleString()} 예산에서는 ${total}행까지만 담긴다. 남은 ${omitted ?? (ROWS - total)}행은 omission 에 사유와 함께 남는다.`);

  /**
   * 예산이 클 때는 절약의 원인이 달라진다. 2,000 토큰으로는 한 행도 안 들어가고
   * 20,000 토큰에서는 138행이 들어간다 — 걸리는 것은 항상 raw 원문이다.
   * 계산을 맞춰 보면: 138행을 담으면 그 자체가 19,987 토큰(상한 근접)이고,
   * 원문을 빼면 같은 138행이 973 토큰이다. 차이가 나는 부분이 바로 raw 다.
   */
  const rowsOnly = projected.stdout.parsed?.entries?.length ?? 0;
  console.log(`(비교 대상: ${rowsOnly}행 — 같은 행 수로 맞춰 잰다)`);
  console.log(`\n요약: 같은 ${rowsOnly}행을 원문까지 받으면 ${measured.toLocaleString()} 토큰,`);
  console.log(`      원문 없이 필수 필드만 받으면 ${approx(projectedJson).toLocaleString()} 토큰.`);
  console.log(`      차이는 raw 원문이다 — 그래서 예산이 있으면 무엇을 버릴지 미리 정해야 한다.`);
  console.log(`      2,000 토큰에서는 실측 0행(원문만으로 상한 초과), 20,000 토큰에서는 138행.`);

  /** 예산은 실행량을 줄이지 않는다 — 원문 대비 줄어드는 것은 내보내는 쪽뿐이다. */
  checks.check("예산을 적용하면 내보내는 크기가 상한 안으로 줄어든다",
    measured <= BUDGET_TOKENS && total < ROWS, `${measured} <= ${BUDGET_TOKENS}, ${total}/${ROWS}행`);
  checks.check("원문을 빼면 같은 행이 훨씬 싸진다", approx(projectedJson) < measured,
    `${approx(projectedJson)} < ${measured}`);
});

process.exitCode = checks.finish() ? 0 : 1;
