#!/usr/bin/env node
/**
 * 보관 결과 재질의 실험 -- 같은 목록에 조건을 바꿔 세 번 물을 때 드는 실행 수와 토큰.
 *
 * 파일 200개가 든 저장소의 `ls -l` 결과에 질문 세 개를 차례로 던진다.
 *
 *   Q1 -- 가장 큰 .ts 파일 3개
 *   Q2 -- 1000바이트 미만인 .json 파일
 *   Q3 -- 디렉터리별 파일 수와 크기 합
 *
 * 세 방식을 비교한다.
 *
 *   raw      -- 원문 전체를 한 번 받아 에이전트가 직접 읽는다
 *   rerun    -- 질문마다 조건을 붙여 명령을 다시 실행한다
 *   requery  -- 첫 실행 결과를 보관하고, 나머지 질문은 query_result로 묻는다
 *
 * 재는 값: 명령 실행 수, 도구 호출 수, 응답 토큰 합. requery의 답이 rerun의 답과 같은지도 확인한다.
 *
 * 사용:
 *   npm run build
 *   node experiments/requery.mjs
 *
 * 작성자: 최진호
 * 작성일: 2026-11-11
 */

import { execFileSync }    from "node:child_process";
import { countJsonTokens, countTokens } from "../dist/engine/budget/tokenizer.js";
import { createEngine }    from "../dist/facade/engine.js";
import { makeListRepo, withTemp } from "./lib/harness.mjs";

const TOKENIZER = "parism/approx";
const DIRS      = ["src", "src/util", "test", "docs"];
const NEXT      = { contract_version: "next", format: "json" };

const QUESTIONS = [
  { name: "Q1 가장 큰 .ts 3개", query: {
    where: [{ field: "name", op: "contains", value: ".ts" }], sort_by: { field: "size_bytes", order: "desc" }, limit: 3,
    select: ["name", "directory", "size_bytes"],
  } },
  { name: "Q2 1000바이트 미만 .json", query: {
    where: [{ field: "name", op: "contains", value: ".json" }, { field: "size_bytes", op: "lt", value: 1000 }],
    select: ["name", "directory", "size_bytes"],
  } },
  { name: "Q3 디렉터리별 수와 크기 합", query: { aggregate: { group_by: ["directory"], sum: ["size_bytes"] } } },
];

const tokens = value => countJsonTokens(value, TOKENIZER);
const rowsOf = parsed => parsed?.entries ?? parsed;

let failed = false;
await withTemp(async root => {
  const { dir } = makeListRepo(root, 200);
  process.env.PARISM_ALLOWED_PATHS = dir;
  const engine = await createEngine();
  const args   = ["-l", ...DIRS];

  /** raw: 원문을 한 번 받는다. 세 질문 모두 이 원문에서 에이전트가 직접 찾는다. */
  const rawText = execFileSync("ls", args, { cwd: dir, encoding: "utf8", env: { ...process.env, LC_ALL: "C" } });
  const raw     = { executions: 1, calls: 1, tokens: countTokens(rawText, TOKENIZER) };

  /** rerun: 질문마다 다시 실행한다. */
  const rerun = { executions: 0, calls: 0, tokens: 0, answers: [] };
  for (const question of QUESTIONS) {
    const result = await engine.run("ls", { ...NEXT, args, cwd: dir, ...question.query });
    rerun.executions++;
    rerun.calls++;
    rerun.tokens += tokens(result);
    rerun.answers.push(rowsOf(result.stdout.parsed));
  }

  /** requery: 첫 질문은 보관하며 실행하고, 나머지는 보관한 결과에 묻는다. */
  const requery = { executions: 1, calls: 1, tokens: 0, answers: [] };
  const first   = await engine.run("ls", { ...NEXT, args, cwd: dir, retain: true, ...QUESTIONS[0].query });
  requery.tokens += tokens(first);
  requery.answers.push(rowsOf(first.stdout.parsed));
  if (!first.review) throw new Error(`first run failed: ${JSON.stringify(first.failure)}`);
  for (const question of QUESTIONS.slice(1)) {
    const result = engine.queryResult(first.review.result_id, question.query);
    requery.calls++;
    requery.tokens += tokens(result);
    requery.answers.push(result.ok ? rowsOf(result.value) : null);
  }

  const total = (rerun.answers[2] ?? []).reduce((sum, row) => sum + row.count, 0);
  console.log(`항목 ${total}개, 토크나이저 ${TOKENIZER}\n`);
  console.log("방식      명령 실행  도구 호출  응답 토큰");
  for (const [name, arm] of [["raw", raw], ["rerun", rerun], ["requery", requery]]) {
    console.log(`${name.padEnd(9)} ${String(arm.executions).padStart(8)} ${String(arm.calls).padStart(10)} ${String(arm.tokens).padStart(10)}`);
  }
  console.log("");
  QUESTIONS.forEach((question, i) => {
    const same = JSON.stringify(rerun.answers[i]) === JSON.stringify(requery.answers[i]);
    if (!same) failed = true;
    console.log(`${same ? "일치  " : "불일치"} ${question.name}: 행 ${Array.isArray(rerun.answers[i]) ? rerun.answers[i].length : "?"}개`);
  });
});
process.exit(failed ? 1 : 0);
