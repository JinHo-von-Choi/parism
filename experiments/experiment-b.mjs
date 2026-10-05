/**
 * 실험 B — 전후 결과에서 새로 생긴 이상 1건과 해결된 1건을 근거로 제시하는가.
 *
 * 계획서 10장 조건:
 *   "전후 결과에서 새로 생긴 이상 한 건과 해결된 한 건을 찾아 원문 근거 제시.
 *    전체 JSON 두 개, 일반 JSON diff, 새 compare_results 를 비교한다.
 *    순서 변화와 잘린 결과를 섞어 거짓 변화·거짓 '문제 없음'을 측정한다."
 *
 * 두 영역을 함께 다룬다. 하나는 "비교해야 하는" 영역이고 다른 하나는 "비교하지 말아야 하는" 영역이다.
 *   - git status --porcelain : 행 identity 가 정해지므로 비교가 성립해야 한다
 *   - kubectl get pods       : 표 출력에 metadata.uid 가 없다.
 *                              재생성된 같은 이름과 구분이 안 되므로 **비교를 보류하는 것이 정답**이다.
 *
 * 무엇을 재 **않는**가: 사람이 "이상"이라고 판단하는지, 확인에 걸린 시간.
 *   그건 5~8명 실험에서 사람이 매긴다.
 *
 * 실행: `npm run build && node experiments/experiment-b.mjs`
 *
 * 작성자: 최진호
 * 작성일: 2026-10-05
 */

import { createEngine } from "../dist/facade/engine.js";
import { Checks, withTemp } from "./lib/harness.mjs";
import { execFileSync } from "node:child_process";
import { writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";

const checks = new Checks("실험 B");

const POD_HEADER = "NAME   READY   STATUS    RESTARTS   AGE";

function renderTable(list) {
  return [POD_HEADER,
    ...list.map(p => `${p.name.padEnd(6)} ${p.ready.padEnd(7)} ${p.status.padEnd(8)} ${String(p.restarts).padEnd(10)} ${p.age}`),
  ].join("\n") + "\n";
}

/** kubectl 흉내내기. 표를 환경변수로 받아 파일을 다시 쓰지 않고 매 실행마다 그 값을 낸다. */
function makeKubectlStub(root) {
  const bin = path.join(root, "bin");
  mkdirSync(bin, { recursive: true });
  const file = path.join(bin, "kubectl");
  writeFileSync(file, "#!/usr/bin/env node\nprocess.stdout.write(process.env.STUB_KUBECTL_TABLE ?? \"\");\n");
  execFileSync("chmod", ["+x", file]);
  return bin;
}

/** 두 JSON 문자열을 줄 단위로 겹쳐 본다. 순서만 다른 줄까지 '어긋남'으로 센다. */
function naiveJsonDiff(a, b) {
  const la = a.split("\n");
  const lb = b.split("\n");
  let diff = 0;
  for (let i = 0; i < Math.max(la.length, lb.length); i++) if (la[i] !== lb[i]) diff++;
  return diff;
}

await withTemp(async (root) => {
  const repo = path.join(root, "repo");
  mkdirSync(repo, { recursive: true });
  const git = (...a) => execFileSync("git", a, { cwd: repo, encoding: "utf8" });
  git("init", "-q");
  git("config", "user.email", "t@t");
  git("config", "user.name", "t");
  for (const n of ["a.txt", "b.txt", "d.txt"]) writeFileSync(path.join(repo, n), `${n}\n`);
  git("add", "-A"); git("commit", "-qm", "seed");
  /** c.txt 는 커밋하지 않는다 — 미추적 → 스테이징으로 가는 '새로 생긴 이상' 재료를 남긴다. */
  writeFileSync(path.join(repo, "c.txt"), "c\n");

  const bin = makeKubectlStub(root);
  process.env.PATH = `${bin}:${process.env.PATH}`;
  process.env.PARISM_ALLOWED_PATHS = repo;
  const engine = await createEngine();

  // ---------------------------------------------------------------------
  // 영역 1. git — 비교가 성립해야 하는 경우
  // ---------------------------------------------------------------------
  console.log(`\n########## 영역 1: git status (비교가 성립해야 한다) ##########`);

  /** 정규화: 저장은 여백을 맞춘 표를 내보내 순서가 흔들리게 한다. */
  const capture = async () => {
    const r = await engine.run("git", {
      args: ["status", "--porcelain=v1", "-z"], cwd: repo,
      contract_version: "next", evidence: "rows", retain: true,
    });
    return r;
  };

  /**
   * b.txt 는 before 시점에 이미 미스테이징 수정 상태로 둔다.
   * 그래야 after 에서 스테이징(" M" → "M ")으로 바뀌어 '해결된 이상'이 'changed' 로 잡힌다.
   * before 에 b.txt 가 없으면 그건 변화가 아니라 '추가된 것'이 된다 — 다른 현상이다.
   */
  writeFileSync(path.join(repo, "b.txt"), "modified\n");

  const before = await capture();
  const beforeId = before.review?.result_id;
  console.log(`\n=== 전(before) ===\n${before.stdout.raw}`);

  /**
   *   - 새로 생긴 이상: c.txt 가 미추적("??") → 스테이징("A  ")으로 상태가 바뀐다
   *   - 해결된 이상: b.txt 가 미스테이징(" M") → 스테이징("M  ")으로 바뀐다
   */
  execFileSync("git", ["add", "c.txt"], { cwd: repo });
  execFileSync("git", ["add", "b.txt"], { cwd: repo });
  const after = await capture();
  const afterId = after.review?.result_id;
  console.log(`=== 후(after) ===\n${after.stdout.raw}`);

  console.log(`\n=== 1) 팔 ①: 두 JSON 을 그대로 나란히 ===`);
  const beforeJson = JSON.stringify(before.stdout.parsed?.entries ?? []);
  const afterJson  = JSON.stringify(after.stdout.parsed?.entries ?? []);
  const naive = naiveJsonDiff(beforeJson, afterJson);
  console.log(`  전 ${beforeJson.length} 문자 / 후 ${afterJson.length} 문자`);
  console.log(`  단순 JSON 비교로 어긋난 줄: ${naive}줄`);
  checks.check("단순 JSON 비교는 배열 순서만 달라도 어긋난 줄을 만든다 (기준선)",
    naive > 0, `${naive}줄`);

  console.log(`\n=== 2) 팔 ②: compare_results ===`);
  const cmp = engine.compare(beforeId, afterId);
  console.log(`  comparable=${cmp.comparable} domain=${cmp.domain}`);
  console.log(`  added=${cmp.added.length} removed=${cmp.removed.length} changed=${cmp.changed.length} unchanged=${cmp.unchanged_count}`);
  console.log(`  changed=${JSON.stringify(cmp.changed)}`);

  checks.check("git 비교가 성립한다", cmp.ok && cmp.comparable, cmp.refusal_reason ?? cmp.message ?? "");

  if (cmp.comparable) {
    const changedPaths = cmp.changed.map(c => c.label);
    const addedPaths   = cmp.added.map(c => c.label);
    const removedPaths = cmp.removed.map(c => c.label);
    console.log(`  changed 경로: ${JSON.stringify(changedPaths)}`);
    console.log(`  added   경로: ${JSON.stringify(addedPaths)}`);
    console.log(`  removed 경로: ${JSON.stringify(removedPaths)}`);

    /** 새로 생긴 이상: c.txt 가 "?? " 에서 "A  " 로 */
    /** label 은 저장소 기준 절대 경로다. 이름 끝부분으로 판정한다. */
    const has = (list, name) => list.some(p => p.endsWith(`/${name}`) || p === name);
    checks.check("새로 생긴 이상(c.txt: 미추적 → 스테이징)을 찾았다",
      has(changedPaths, "c.txt") || has(addedPaths, "c.txt"),
      `changed=${JSON.stringify(changedPaths)} added=${JSON.stringify(addedPaths)}`);
    /** 해결된 이상: b.txt 가 " M" 에서 "M  " 으로 */
    checks.check("해결된 이상(b.txt: 미스테이징 → 스테이징)을 찾았다",
      has(changedPaths, "b.txt"),
      `changed=${JSON.stringify(changedPaths)}`);

    /** 필드 변화마다 근거 포인터가 붙어야 '원문 근거 제시'가 성립한다 */
    const withPointers = cmp.changed.filter(c =>
      (c.base_pointer !== undefined) || (c.current_pointer !== undefined) || c.fields);
    checks.check("필드 변화에 근거를 붙인다", withPointers.length > 0, `${withPointers.length}/${cmp.changed.length}건`);

    checks.check("무시한 필드를 밝힌다", Array.isArray(cmp.ignored_fields), cmp.ignored_fields.join(",") || "(없음)");

    /** 근거가 실제로 그 필드를 가리키는지 원문으로 되짚는다 */
    const row = cmp.changed.find(c => (c.label ?? "").endsWith("/b.txt"));
    if (row?.fields) {
      const fieldNames = Object.keys(row.fields);
      console.log(`  b.txt 의 바뀐 필드: ${JSON.stringify(fieldNames)}`);
      checks.check("b.txt 의 상태 필드가 xy 로 묶여 나온다", fieldNames.includes("xy"), fieldNames.join(","));
    }
  }

  console.log(`\n=== 3) 순서 변화는 거짓 변화가 아니다 ===`);
  /**
   * 실측: `git status --porcelain` 은 경로순으로 정렬해 출력한다.
   * 그래서 같은 파일 집합으로는 순서를 뒤집을 수 없다(아래의 '픽스처가 실제로 순서를 뒤집었다'가 그 확인이다).
   * 이 실험은 목록 끝에 다른 파일을 하나 넣어 **순서가 달라진 상태**를 만든 뒤,
   * 그 추가 1건만 '추가'로 잡히고 나머지는 '변화 없음'인지 본다.
   */
  writeFileSync(path.join(repo, "a.txt"), "touched\n");
  const reordered = await capture();
  const afterNames = (after.stdout.parsed?.entries ?? []).map(e => e.path);
  const reorderedNames = (reordered.stdout.parsed?.entries ?? []).map(e => e.path);
  console.log(`  전 목록: ${JSON.stringify(afterNames)}`);
  console.log(`  후 목록: ${JSON.stringify(reorderedNames)}`);
  checks.check("픽스처가 목록을 실제로 늘렸다",
    reorderedNames.length === afterNames.length + 1,
    `${afterNames.length} → ${reorderedNames.length}`);

  const reorderedCmp = engine.compare(afterId, reordered.review?.result_id);
  console.log(`  comparable=${reorderedCmp.comparable} changed=${reorderedCmp.changed.length} added=${reorderedCmp.added.length} removed=${reorderedCmp.removed.length}`);

  /** 앞서 after 에서 이미 스테이징한 두 행은 그대로여야 한다. */
  checks.check("나머지 행을 거짓 변화로 잡지 않는다",
    reorderedCmp.changed.length === 0 && reorderedCmp.removed.length === 0,
    `changed=${reorderedCmp.changed.length} removed=${reorderedCmp.removed.length}`);
  checks.check("새로 들어온 1건만 '추가'로 잡는다",
    reorderedCmp.added.length === 1 && reorderedCmp.added[0].label.endsWith("/a.txt"),
    `added=${JSON.stringify(reorderedCmp.added.map(r => r.label))}`);

  const sameCmp = engine.compare(afterId, afterId);
  checks.check("같은 결과를 두 번 비교하면 변화 0",
    sameCmp.comparable && sameCmp.changed.length === 0 && sameCmp.added.length === 0
      && sameCmp.removed.length === 0 && sameCmp.unchanged_count > 0,
    `unchanged=${sameCmp.unchanged_count}`);

  console.log(`\n=== 4) 거짓 '문제 없음': 잘린 결과로 비교 ===`);
  /**
   * 수집 상한을 낮춰 결과를 자른다. 자른 쪽에서 사라진 행을 '삭제'로 단정하지 않아야 한다.
   */
  const smallCfg = path.join(root, "small.config.json");
  writeFileSync(smallCfg, JSON.stringify({ guard: { allowed_paths: [repo], max_output_bytes: 12 } }));
  const smallEngine = await createEngine({ configPath: smallCfg });
  const truncated = await smallEngine.run("git", {
    args: ["status", "--porcelain=v1", "-z"], cwd: repo,
    contract_version: "next", evidence: "rows", retain: true,
  });
  console.log(`  잘린 결과 truncated=${truncated.truncated} raw 길이=${truncated.stdout.raw.length}`);
  console.log(`  review: source_complete=${truncated.review?.source_complete}`);
  console.log(`  warnings: ${JSON.stringify(truncated.review?.warnings)}`);

  checks.check("잘렸음을 review 가 밝힌다",
    truncated.truncated === true && truncated.review?.source_complete === false,
    `truncated=${truncated.truncated} source_complete=${truncated.review?.source_complete}`);
  checks.check("잘린 이유를 warnings 로 밝힌다",
    (truncated.review?.warnings ?? []).length > 0, (truncated.review?.warnings ?? []).join(" / "));

  const truncatedCmp = smallEngine.compare(truncated.review?.result_id, afterId);
  console.log(`  잘린 쪽끼리 비교: comparable=${truncatedCmp.comparable} removed=${truncatedCmp.removed.length}`);
  console.log(`  partial=${JSON.stringify(truncatedCmp.partial)}`);
  console.log(`  refusal=${truncatedCmp.refusal_reason ?? "-"}`);

  checks.check("잘린 결과에서 거짓 삭제를 만들지 않는다",
    truncatedCmp.removed.length === 0, `removed=${truncatedCmp.removed.length}`);
  checks.check("불완전함을 감추지 않는다",
    truncatedCmp.partial.base_incomplete || truncatedCmp.partial.current_incomplete
      || truncatedCmp.partial.withheld_reasons.length > 0
      || truncatedCmp.refusal_reason !== undefined,
    `withheld=${JSON.stringify(truncatedCmp.partial.withheld_reasons)} refusal=${truncatedCmp.refusal_reason}`);

  // ---------------------------------------------------------------------
  // 영역 2. kubectl 표 — 비교를 보류하는 것이 정답인 경우
  // ---------------------------------------------------------------------
  console.log(`\n\n########## 영역 2: kubectl get pods (비교를 보류하는 것이 정답) ##########`);

  const podsBefore = [
    { name: "api-1", ready: "1/1", status: "Running",         restarts: 0, age: "5d" },
    { name: "api-2", ready: "1/1", status: "Running",         restarts: 0, age: "5d" },
    { name: "web-1", ready: "0/1", status: "Pending",          restarts: 0, age: "2m" },
  ];
  const podsAfter = [
    { name: "api-1", ready: "1/1", status: "Running",         restarts: 0, age: "5d" },
    { name: "api-2", ready: "0/1", status: "CrashLoopBackOff", restarts: 7, age: "5d" },
    { name: "web-1", ready: "1/1", status: "Running",         restarts: 0, age: "3m" },
  ];
  console.log(`\n=== 전 ===\n${renderTable(podsBefore)}=== 후 ===\n${renderTable(podsAfter)}`);

  process.env.STUB_KUBECTL_TABLE = renderTable(podsBefore);
  const pBase = await engine.run("kubectl", {
    args: ["get", "pods"], cwd: repo, contract_version: "next", evidence: "rows", retain: true,
  });
  process.env.STUB_KUBECTL_TABLE = renderTable(podsAfter);
  const pCur = await engine.run("kubectl", {
    args: ["get", "pods"], cwd: repo, contract_version: "next", evidence: "rows", retain: true,
  });
  console.log(`  파싱: ${JSON.stringify(pCur.stdout.parsed).slice(0, 180)}`);

  const pCmp = engine.compare(pBase.review?.result_id, pCur.review?.result_id);
  console.log(`  comparable=${pCmp.comparable} domain=${pCmp.domain} changed=${pCmp.changed.length}`);
  console.log(`  보류 사유: ${JSON.stringify(pCmp.partial.withheld_reasons)}`);

  checks.check("uid 없는 표는 비교를 보류한다", pCmp.comparable === false, `comparable=${pCmp.comparable}`);
  checks.check("보류 사유를 말해 준다", pCmp.partial.withheld_reasons.length > 0,
    pCmp.partial.withheld_reasons[0] ?? "(사유 없음)");
  checks.check("보류 상태에서 거짓 변경을 내지 않는다",
    pCmp.changed.length === 0 && pCmp.added.length === 0 && pCmp.removed.length === 0,
    `changed=${pCmp.changed.length} added=${pCmp.added.length} removed=${pCmp.removed.length}`);
  checks.check("파서가 표를 행 배열로 읽는다",
    Array.isArray(pCur.stdout.parsed?.pods) && pCur.stdout.parsed.pods.length === 3,
    `${pCur.stdout.parsed?.pods?.length ?? 0}행`);

  console.log(`\n=== 5) 비교는 명령을 다시 실행하지 않는다 ===`);
  const cmp2 = engine.compare(beforeId, afterId);
  checks.check("비교를 두 번 해도 결과가 같다",
    JSON.stringify(cmp2.changed) === JSON.stringify(cmp.changed)
    && JSON.stringify(cmp2.added) === JSON.stringify(cmp.added),
    "");
  const missing = engine.compare("r_없는_아이디", afterId);
  checks.check("보관 안 된 결과는 재실행 없이 거절한다",
    missing.ok === false && missing.refusal_reason === "result_not_retained",
    missing.refusal_reason ?? "(거절되지 않음)");
});

process.exitCode = checks.finish() ? 0 : 1;
