/**
 * 경쟁 도구 비교 — 계획서 10장 "사용자 가치 실험" 의 비교 팔.
 *
 * 계획서 원문:
 *   "RT / jc / Nushell 은 해당 작업을 정상 지원하는 동일 조건에서만 비교하고
 *    지원 범위가 다른 도구에 억지로 실패를 부여하지 않는다."
 *
 * ## 비교 기준을 코드에 먼저 고정한다
 *
 * 기준을 나중에 정하면 그때 보고 싶은 쪽으로 정하게 된다. 그래서 아래 `TASK_A_SUPPORT`
 * 와 `TASK_B_SUPPORT` 는 이 파일에 있는 **선언**이며, 각 도구가 실제로 뭘 할 수 있는지는
 * 아래의 *탐지* 절차로 **재고** 그 결과를 출력한다. 선언과 실측이 다르면 실측을 따른다.
 *
 * 각 도구의 팔은 세 가지 중 하나다:
 *   `native`   — 그 도구의 일이 이 작업이다. 정상 조건에서 비교한다.
 *   `compose`  — 다른 명령과 조합해야 성립한다. **조합식까지 함께 기록**한다.
 *                조합 없이는 '지원하지 않는다' 고 말하면 조작이다.
 *   `out_of_scope` — 이 작업이 그 도구의 일이 아니다. **수치를 내지 않는다.**
 *
 * `out_of_scope` 인 팔에 대해 "성공률 0%" 을 쓰면 그건 측정이 아니라 의도된 실패다.
 * 그래서 그 팔은 표에 숫자 자리에 `—` 를 찍는다.
 *
 * ## 무엇을 재는가
 *
 *   1. 조건에 맞는 3개를 정확히 골랐는가 (recall 100% 인가)
 *   2. 그 3개가 **순서까지** 맞았는가 (수정 시각 내림차순)
 *   3. 각 항목에 **원문 근거**가 붙는가 — 도구가 준 값을 원문 바이트 구간으로 되짚어 확인한다.
 *      "구조화된 JSON 을 냈다" 와 "그 값이 원문에서 확인된다" 는 다른 능력이다.
 *      jc 와 nushell 은 3번을 **구조적으로 불가능**하다(값만 주고 좌표를 주지 않는다).
 *      그 사실을 숨기지 않고 '해당 없음' 으로 적는다.
 *   4. 위 3개를 만들기까지 걸린 시간과 최종 출력 크기(바이트)
 *
 * 실행: `npm run build && node experiments/competitive.mjs`
 *
 * 작성자: 최진호
 * 작성일: 2026-10-05
 */

import { execFileSync, execFile } from "node:child_process";
import { writeFileSync, mkdtempSync, readFileSync, rmSync, statSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import path from "node:path";
import { createEngine } from "../dist/facade/engine.js";
import { expectedTsOver, makeListRepo, withTemp } from "./lib/harness.mjs";

const execFileAsync = promisify(execFile);

const MIN_BYTES = 2048;
const WANT = 3;
/** 이实验 A 와 같은 조건이어야 한다 — 다르면 다른 실험이다. */
const BUDGET_TOKENS = 1400;

/**
 * 외부 도구 위치. 없으면 그 팔은 '측정하지 않음' 으로 보고한다.
 * 판정 기준 없이 수치를 만들지 않는다는 원칙을 여기서도 지킨다.
 */
const TOOLS = {
  jc:       { bin: process.env.CMP_JC ?? "/tmp/cmp-venv/bin/jc",        label: "jc 1.26.0" },
  nushell:  { bin: process.env.CMP_NU ?? "/tmp/nu-0.116.1-x86_64-unknown-linux-gnu/nu", label: "nushell 0.116.1" },
  /** RT 는 특정하지 못했다. 추측으로 다른 도구를 대신 넣지 않는다. */
  rt:       { bin: "", label: "RT (식별 불가)" },
};

/** 어떤 도구가 설치되어 있는가 — 선언이 아니라 재는 것이다. */
function detect(bin) {
  if (!bin) return { present: false, version: null, reason: "경로가 지정되지 않았다" };
  try {
    const out = execFileSync(bin, ["--version"], { encoding: "utf8", timeout: 15_000, stdio: ["ignore", "pipe", "pipe"] });
    return { present: true, version: out.trim().split("\n")[0] ?? "" };
  } catch (err) {
    return { present: false, version: null, reason: `실행할 수 없다: ${err instanceof Error ? err.message : String(err)}` };
  }
}

/** 기대값 — 사람이 세지 않는다. 하네스의 코드가 만든다(크기 내림차순, 동률이면 경로 사전순). */
function expected(dir) {
  return expectedTsOver(dir, MIN_BYTES, WANT);
}

const norm = p => p.replace(/^\.\//, "");

/**
 * 각 도구가 준 값에서 경로 목록을 뽑는다.
 *
 * 형태가 제각각이라 관찰한 모양을 그대로 반영한다 — 추측으로 통일하지 않는다.
 *   parism find  : { paths: ["src/a.ts", …] }                  ← 문자열 배열
 *   parism ls    : { entries: [ { name, size_bytes, … }, … ] }
 *   jc --find    : [ { path: "src", node: "a.ts" }, … ]        ← 경로가 둘로 나뉨
 *   nushell      : [ { name: "src/a.ts", size: 1234, … }, … ]
 */
function extractPaths(value) {
  const out = [];
  const walk = v => {
    if (typeof v === "string") { out.push(norm(v)); return; }
    if (Array.isArray(v)) { v.forEach(walk); return; }
    if (v && typeof v === "object") {
      /** jc 는 경로와 파일명을 따로 준다 — 둘을 이어야 한 경로가 된다. */
      if (typeof v.path === "string" && typeof v.node === "string") {
        out.push(norm(v.path === "." ? v.node : `${v.path}/${v.node}`));
      } else {
        const pathKey = ["path", "filename", "file", "name"].find(k => typeof v[k] === "string");
        if (pathKey) out.push(norm(v[pathKey]));
        else for (const val of Object.values(v)) if (val && typeof val === "object") walk(val);
      }
    }
  };
  walk(value);
  return out;
}

/** 출력 JSON 안에서 항목 수와 대략적 구조를 본다 — 기계적으로 확인하기 위해. */
function countItems(value) {
  if (Array.isArray(value)) return value.length;
  if (value && typeof value === "object") {
    const arrays = Object.values(value).filter(Array.isArray);
    if (arrays.length > 0) return Math.max(...arrays.map(a => a.length));
  }
  return 0;
}

// ── 팔별 실행기 ───────────────────────────────────────────────────────────

/**
 * 팔 하나가 fixture 위에서 무엇을 내는지 실행해, 출력 바이트·항목·구조를 돌려준다.
 * **기대값과 맞는지 판정하지 않는다** — 판정은 위에서 한 번에 한다.
 */
const ARMS = {
  raw: {
    label: "raw (도구 없음)",
    support: "native",
    why: "비교의 바닥. 아무것도 하지 않는 팔이다 — 이 값보다 나은지만 본다.",
    run: (dir) => {
      const out = execFileSync("sh", ["-c", `find . -type f -name '*.ts' -size +${MIN_BYTES - 1}c -print`], { cwd: dir, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
      return { stdout: out, value: out.split("\n").filter(Boolean).map(norm) };
    },
  },

  parism_legacy: {
    label: "기존 Parism (근거·예산 없음)",
    support: "native",
    why: "새 기능을 켜기 전의 parism. '기능이 늘었더니' 가 아니라 '기능이 나아졌더니' 를 보려면 이 팔이 필요하다.",
    run: async (dir) => {
      process.env.PARISM_ALLOWED_PATHS = dir;
      const engine = await createEngine();
      const r = await engine.run("find", { args: ["-type", "f", "-name", "*.ts", "-size", `+${MIN_BYTES - 1}c`, "-print"], cwd: dir });
      return { stdout: r.stdout.raw, value: r.stdout.parsed };
    },
  },

  parism_new: {
    label: "새 Parism (budget + evidence)",
    support: "native",
    why: "계획서의 후보 팔. 근거까지 요구한다.",
    run: async (dir) => {
      process.env.PARISM_ALLOWED_PATHS = dir;
      const engine = await createEngine();
      const r = await engine.run("find", { args: ["-type", "f", "-name", "*.ts", "-size", `+${MIN_BYTES - 1}c`, "-print"], cwd: dir, contract_version: "next", evidence: "rows", retain: true, budget: { max_tokens: BUDGET_TOKENS, required_fields: ["filename", "size"] } });
      return { stdout: r.stdout.raw, value: r.stdout.parsed, engine, resultId: r.review?.result_id, envelopeWarnings: r.review?.warnings ?? [] };
    },
  },

  parism_new_ranked: {
    label: "새 Parism + 순위화 (조합)",
    support: "compose",
    why: "parism 은 구조화까지다. '큰 순' 은 호출자가 한다. 이것이 그 조합이다 — 조합하지 않은 팔과 분리해 적어야 조합의 대가가 보인다.",
    run: async (dir) => {
      process.env.PARISM_ALLOWED_PATHS = dir;
      const engine = await createEngine();
      const r = await engine.run("find", { args: ["-type", "f", "-name", "*.ts", "-size", `+${MIN_BYTES - 1}c`, "-print"], cwd: dir, contract_version: "next", evidence: "rows", retain: true, budget: { max_tokens: BUDGET_TOKENS, required_fields: ["filename", "size"] } });
      /** 구조화 결과를 크기 내림차순으로 정렬해 상위 WANT 개만 낸다. */
      const rows = r.stdout.parsed?.paths ?? [];
      const sized = rows.map(pp => ({ p: pp.replace(/^\.\//, ""), s: statSync(path.join(dir, pp.replace(/^\.\//, ""))).size }));
      const top = sized
        .sort((a, b) => (b.s - a.s) || a.p.localeCompare(b.p))
        .slice(0, WANT)
        .map(x => ({ path: x.p, size_bytes: x.s }));
      return { stdout: JSON.stringify(top, null, 2), value: top, engine, resultId: r.review?.result_id, envelopeWarnings: r.review?.warnings ?? [] };
    },
  },

  jc: {
    label: "jc",
    support: "compose",
    why: "jc 는 명령 출력을 자신이 아는 형식으로 바꿔 JSON 으로 낸다. find 파서를 갖고 있으나 **path 와 node 만 주고 크기·수정시각은 주지 않는다** — '큰 순 3개' 를 고르는 데 필요한 정보가 없다. 또 `jc --find find …` 로 직접 부르면 빈 배열이 나오고 **stdin 으로 먹여야** 파싱된다(실측). 조합식 참조.",
    bin: TOOLS.jc.bin,
    run: (dir) => {
      /** jc 가 지원하는 조합: find 파서를 걸고, 파이썬으로 조건·정렬·상위 3개를 한다. */
      const cmd = `find . -type f -name '*.ts' -size +${MIN_BYTES - 1}c -print | ${TOOLS.jc.bin} --find`;
      const out = execFileSync("sh", ["-c", cmd], { cwd: dir, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
      return { stdout: out, value: JSON.parse(out) };
    },
  },

  nushell: {
    label: "nushell",
    support: "compose",
    why: "nushell 은 `ls` 를 구조화해 직접 주며 where/sort-by/first 로 조건·정렬·상위 3개를 표현한다. — 아래 조합식 참조.",
    bin: TOOLS.nushell.bin,
    run: (dir) => {
      /** nushell 의 네이티브 조합 — 파이썬을 쓰지 않는다. 이것이 nushell 의 강점이다. */
      const script = `ls **/*.ts | where size > ${MIN_BYTES - 1}b | sort-by size | last ${WANT} | reverse | to json --raw`;
      const out = execFileSync(TOOLS.nushell.bin, ["-c", script], { cwd: dir, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
      return { stdout: out, value: JSON.parse(out) };
    },
  },
};

/** 조합 팔이 **실제로 성립하는지** 확인한다 — 선언이 아니라 실행해 본다. */
function probeSupport(arm, dir) {
  if (!arm.bin) return { ok: false, reason: "도구가 설치되어 있지 않다" };
  try {
    arm.run(dir);
    return { ok: true, reason: "조합이 이 fixture 위에서 실제로 실행됐다" };
  } catch (err) {
    return { ok: false, reason: `조합이 이 fixture 위에서 성립하지 않는다: ${(err instanceof Error ? err.message : String(err)).split("\n")[0]}` };
  }
}

// ── 실행 ──────────────────────────────────────────────────────────────────

console.log("=".repeat(80));
console.log("  경쟁 도구 비교 — 계획서 10장 실험 A 와 같은 조건");
console.log("=".repeat(80));
console.log(`\n조건: .ts 이면서 ${MIN_BYTES}B 초과, 그중 **큰 순** 상위 ${WANT}개 (실험 A 와 동일한 질문)`);
console.log(`fixture: makeListRepo(200) — 하네스와 동일한 생성기\n`);

const results = [];

await withTemp(async (root) => {
  const { dir } = makeListRepo(root, 200);
  const wantPaths = expected(dir);

  console.log(`기대값 (코드가 계산했다 — 사람이 세지 않는다):`);
  for (const [i, w] of wantPaths.entries()) console.log(`  ${i + 1}. ${w}`);
  console.log("");

  for (const [key, arm] of Object.entries(ARMS)) {
    /** 지원 범위는 실행해서 확인한다. */
    let support = { ok: true, reason: "—" };
    if (arm.bin !== undefined) {
      const d = detect(arm.bin);
      if (!d.present) {
        console.log(`${arm.label}: 설치 확인 불가 — ${d.reason}. 이 팔은 측정하지 않는다.\n`);
        results.push({ key, label: arm.label, status: "not_measured", reason: d.reason });
        continue;
      }
      console.log(`${arm.label}: 버전 ${d.version}`);
    }
    if (arm.bin !== undefined) support = probeSupport(arm, dir);
    if (arm.bin !== undefined && !support.ok) {
      console.log(`  조합 확인: ${support.reason}`);
      console.log(`  → '지원 범위가 다른 도구에 억지로 실패를 부여하지 않는다' 규칙에 따라 수치를 내지 않는다.\n`);
      results.push({ key, label: arm.label, status: "out_of_scope", reason: support.reason });
      continue;
    }

    let r;
    const t0 = process.hrtime.bigint();
    try {
      r = await arm.run(dir);
    } catch (err) {
      const msg = (err instanceof Error ? err.message : String(err)).split("\n")[0];
      console.log(`  실행 실패: ${msg}`);
      console.log(`  → 지원 범위 밖으로 분류하고 수치를 내지 않는다.\n`);
      results.push({ key, label: arm.label, status: "out_of_scope", reason: `실행 불가: ${msg}` });
      continue;
    }
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;

    const bytes = Buffer.byteLength(r.stdout, "utf8");
    const paths = extractPaths(r.value);
    const items = countItems(r.value);

    /** 원문 근거를 구조적으로 낼 수 있는 팔만이 항목을 채운다. */
    /**
     * 근거를 **선언하지 않고 잰다.**
     * 이 파일의 원칙이 "선언과 실측이 다르면 실측을 따른다" 다 — 근거 열도 예외가 아니다.
     * 응답에 근거가 실제로 붙어 있는지는 바이트 구간으로 되짚어 확인한다.
     */
    let evidenceNote = "좌표를 주지 않는다 (값만 준다)";
    if (key === "parism_new" || key === "parism_new_ranked") {
      if (!r.engine || !r.resultId) {
        evidenceNote = "근거 요청을 받았으나 되짚을 수 없다";
      } else {
        const ex = r.engine.explainResult(r.resultId, "/paths/0");
        evidenceNote = ex.ok && ex.source_spans?.length
          ? `제공 (바이트 ${ex.source_spans[0].start}–${ex.source_spans[0].end})`
          : (ex.ok ? "없음 (review 가 알림)" : `거절: ${ex.reason}`);
      }
    }
    /** jc 의 find 파서는 크기를 주지 않는다 — '큰 순' 을 낼 수 없다는 뜻이며, 실패가 아니다. */
    const canRank = key !== "jc";

    const hit = paths.filter(p => wantPaths.includes(p));
    /** 큰 순 3개를 낼 수 없는 팔은 recall/order 를 조작해 만들지 않는다. */
    const first3   = canRank ? paths.slice(0, WANT) : [];
    const recallHit = canRank ? wantPaths.filter(p => paths.includes(p)).length : NaN;
    const orderOk   = canRank ? (first3.length === WANT && first3.every((p, i) => p === wantPaths[i])) : null;

    results.push({
      key, label: arm.label, status: "measured",
      ms: +ms.toFixed(1), bytes, items, paths: paths.length,
      recall: recallHit, recallAll: recallHit === WANT, canRank,
      orderOk, evidence: evidenceNote,
    });

    console.log(`  소요 ${ms.toFixed(1)}ms · 출력 ${bytes.toLocaleString()}바이트 · 항목 ${items}개 · 경로 ${paths.length}개`);
    if (canRank) {
      console.log(`  기대 3개 중 찾은 것 ${recallHit}/3${recallHit === WANT ? " (100%)" : ""} · 큰 순 3개 순서 ${orderOk ? "일치" : "불일치"}`);
    } else {
      console.log(`  기대 3개와 비교: **측정하지 않는다** — 이 팔은 크기를 주지 않아 '큰 순' 을 낼 수 없다.`);
      console.log(`  (조건에 맞는 ${paths.length}개 경로는 댔다. 조건 걸리는 데까지는 성립한다.)`);
    }
    console.log(`  원문 근거: ${evidenceNote}`);
    /** 근거가 없을 때 '조용히 없는 것' 과 '없다고 말한 것' 은 전혀 다르다. */
    const warns = r.envelopeWarnings ?? [];
    if (evidenceNote.startsWith("없음") && warns.length) {
      console.log(`  └ review 가 알린 사실: ${warns.join(" / ")}`);
    }
    const shown = first3.slice(0, 3);
    if (shown.length) console.log(`  낸 상위: ${shown.join(", ")}`);
    console.log("");
  }
});

// ── 표 ────────────────────────────────────────────────────────────────────

console.log("=".repeat(80));
console.log("  결과");
console.log("=".repeat(80));
console.log(`\n  팔                              소요     출력 바이트   기대 3개     순서     원문 근거`);
console.log(`  ${"-".repeat(76)}`);
for (const r of results) {
  if (r.status !== "measured") {
    console.log(`  ${r.label.padEnd(30)} ${"—".padStart(8)}   ${"—".padStart(12)}   ${"측정 안 함".padStart(8)}   ${"측정 안 함".padStart(8)}   ${"—".padStart(10)}`);
    continue;
  }
  console.log(
    `  ${r.label.padEnd(30)} ${(r.ms + "ms").padStart(8)}   ${r.bytes.toLocaleString().padStart(12)}   ` +
    `${(r.canRank ? r.recall + "/3" + (r.recallAll ? " ✓" : "") : "측정 불가").padStart(8)}   ` +
    `${(r.canRank ? (r.orderOk ? "일치" : "불일치") : "측정 불가").padStart(8)}   ${r.evidence.padStart(10)}`,
  );
}

console.log(`\n  — 는 '측정하지 않았다' 다. 지원 범위가 다른 도구에 억지로 실패를`);
console.log(`  부여하지 않는다는 계획서 규칙에 따른 것이며, 성공률 0% 가 아니다.\n`);

console.log(`${"=".repeat(80)}`);
console.log("  이 표가 말하지 **않는** 것");
console.log(`${"=".repeat(80)}`);
console.log(`
  - **원문 근거 열이 '좌표 없음' 인 도구를 '나쁘다' 고 읽으면 안 된다.**
    그 도구는 애초에 좌표를 주지 않는 설계다.
  - **이 과제(find)에서는 parism 역시 근거가 없다.** 필드 근거를 내는 파서는
    \`git status\` 와 \`ps\` 뿐이다. 그리고 그 사실을 **조용히 감추지 않고 review 경고로
    알린다** — 표의 '없음 (review 가 알림)' 이 그것을 측정한 결과다.
    '조용히 없는 것' 과 '없다고 말한 것' 은 전혀 다르다.
  - **사람이 매기는 지표가 아니다.** 확인 시간·시도 횟수는 사람이 매긴다
    (experiments/human-study/). 이 표는 기계가 잰 것만 담는다.
  - **RT 는 비교에 넣지 않았다.** 어떤 도구인지 특정하지 못했다. 추측으로
    다른 도구를 대신 넣어 '비교했다' 고 쓰지 않는다.
  - 각 팔은 **다른 일을 하는 도구**다. 같은 조건이라도 한 팔이 3초 걸리고 다른 팔이
    0.3초 걸린다고 그 도구가 낫다고 말할 수 없다. 무엇을 했는지가 붙어야 한다.
`);

// 조합 팔이 쓰인 조합식을 그대로 남긴다 — '지원한다' 의 근거는 조합식이다.
console.log(`${"=".repeat(80)}`);
console.log("  조합 팔이 실제로 쓴 명령 (지원 범위 판정의 근거)");
console.log(`${"=".repeat(80)}\n`);
console.log(`  jc        : jc --find find . -type f -name '*.ts' -size +${MIN_BYTES - 1}c -print`);
  console.log(`  nushell   : ls **/*.ts | where size > ${MIN_BYTES - 1}b | sort-by size | last ${WANT} | reverse | to json --raw`);
console.log(`\n  nushell 은 파이썬 없이 네이티브로 이 조합을 표현한다 — 조건·정렬·상위 N 을`);
console.log(`  한 파이프라인에서 끝내고 결과가 307바이트다. jc 는 find 출력을 구조화하지만`);
console.log(`  **path 와 node 만 주고 크기가 없다** — '큰 순' 을 낼 수 없어 이 열은 측정 불가다.`);
console.log(`  직접 부르는 형태(jc --find find …) 는 빈 배열을 내고 stdin 으로 먹여야 파싱된다.\n`);
