/**
 * 성능 게이트 — 계획서 10장 "성능 게이트".
 *
 *   "새 기능 off는 기존 동일 커밋 경로 대비 throughput과 p95 지연의 10% 이상 회귀가 없는 것을
 *    목표로 한다. 새 기능 on의 추가 시간·peak RSS·worker CPU·저장 바이트를 1KB/100KB/1MB fixture,
 *    concurrency 1/4/16에서 따로 공개한다."
 *
 * 같은 커밋에서 두 경로를 함께 재는 이유: 이전 커밋을 빌드해서 비교하면
 * 빌드 차이와 코드 차이를 분리할 수 없다. `off` 는 새 인자를 하나도 주지 않는 경로,
 * `on` 은 근거·예산·보관을 모두 켠 경로다. 둘 다 지금 이 커밋의 코드다.
 *
 * **10% 는 출시 판정을 위한 초기 예산이며 현재 측정값이 아니다.**
 * 이 스크립트는 그 판단에 필요한 숫자를 만들 뿐, 판정하지 않는다.
 *
 * 실행: `npm run build && node experiments/perf-gate.mjs`
 *       `node experiments/perf-gate.mjs --only=100KB,1MB`        크기 축만 좁힌다
 *       `PERF_REPEAT=3 PERF_WARMUP=1 node experiments/perf-gate.mjs`   짧게 훑는다
 *
 * 작성자: 최진호
 * 작성일: 2026-10-05
 */

import { ParismEngine } from "../dist/facade/engine.js";
import { DEFAULT_CONFIG } from "../dist/config/loader.js";
import { createRegistry } from "../dist/parsers/index.js";
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir, cpus } from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

/** 요약 통계 — 평균만으로는 꼬리를 못 본다. p95 를 같이 낸다. */
function stats(samples) {
  const sorted = [...samples].sort((a, b) => a - b);
  const sum    = sorted.reduce((a, b) => a + b, 0);
  return {
    n:    sorted.length,
    mean: sum / sorted.length,
    p50:  sorted[Math.floor(sorted.length * 0.50)],
    p95:  sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)],
    max:  sorted[sorted.length - 1],
  };
}

const fmt    = s => `${s.mean.toFixed(1)}ms (p50 ${s.p50.toFixed(1)} / p95 ${s.p95.toFixed(1)} / max ${s.max.toFixed(1)})`;
/** 초 단위 토큰 수의 근사 — parism/approx 와 같은 축척 */
const approx = s => Math.round(s.length / 3.6);
const kib    = n => `${(n / 1024).toFixed(1)}KB`;
const pct    = v => `${v >= 0 ? "+" : ""}${v.toFixed(1)}%`;

/**
 * ── 한 줄의 길이를 '재서' 파일 수를 정한다 ──────────────────────────────────
 *
 * 처음에는 "파일 수를 199개로 고정하고 파일 이름 길이로 한 줄을 늘린다"로 설계했다.
 * **실패했다.** 파일 이름에는 255바이트 한계가 있어 199 × 약 320바이트 ≈ 64KB 가 끝이다.
 * 실제 100KB fixture 생성에서 `File name too long` 로 전량 실패했다.
 * 파일 수와 자기검증(요청 수 = 실제 수)이 이 실패를 잡았다.
 *
 * 그래서 축을 바꿨다 — **한 줄의 길이는 고정하고 줄 수(파일 수)로 크기를 만든다.**
 * 한 줄 길이는 이름 길이를 '대충' 정하지 않고 작은 디렉터리에서 실제 명령을 돌려 잰다.
 * 만들어진 fixture 의 실제 stdout 크기도 parism 으로 다시 재 목표와 비교한다.
 *
 * 두 명령은 줄을 늘리는 방법이 다르다:
 *
 * - `ls -l` 은 재귀가 없다. 하위 디렉터리에 넣으면 `total N` 한 줄만 나온다.
 *   그래서 **평평한 디렉터리**에 이름이 짧은 파일을 많이 놓는다(실측 50.4B/줄 → 1MB 에 20,800개).
 * - `git status --porcelain` 은 재귀라 경로 전체가 줄에 나온다.
 *   다만 **미추적 디렉터리는 `?? d00/` 로 접어 버린다**(실측). 그래서 `git add` + 커밋으로
 *   추적 파일로 만든 뒤 내용을 바꿔야 줄이 하나씩 나온다.
 *   이름이 200자인 디렉터리 하나에 모아 두면 214B/줄 → 1MB 에 5,000개로 충분했다.
 */
const NAME_POOL = n => `f${String(n).padStart(6, "0")}.ts`;
const LONG_DIR  = "d".repeat(200);

/**
 * 보정 — 작은 별도 디렉터리에서 **재려는 그 명령을 그대로 돌려** 한 줄당 바이트를 잰다.
 *
 * 보정 파일을 본 디렉터리에 남기면 자기검증(요청 수 = 실제 수)이 실패한다 — 실제로 그랬다.
 * 또 보정을 `ls` 로 재면 git fixture 를 재지 못한다(200자 디렉터리는 `ls` 에 한 줄로 나온다).
 * 그래서 명령마다 자기 보정 함수를 갖는다.
 */
function calibrate(build, measure) {
  const calDir = mkdtempSync(path.join(tmpdir(), "parism-perf-cal-"));
  try {
    build(calDir, 64);
    const out   = measure(calDir);
    const lines = out.split("\n").filter(l => l.length > 0).length;
    return { perLine: Buffer.byteLength(out, "utf8") / Math.max(1, lines) };
  } finally {
    rmSync(calDir, { recursive: true, force: true });
  }
}

const lsFixture = (dir, n) => {
  for (let i = 0; i < n; i++) writeFileSync(path.join(dir, NAME_POOL(i)), "x\n");
  return 0;
};

const gitFixture = (dir, n) => {
  const sub = path.join(dir, LONG_DIR);
  mkdirSync(sub, { recursive: true });
  for (let i = 0; i < n; i++) writeFileSync(path.join(sub, NAME_POOL(i)), "x\n");
  const git = (...a) => execFileSync("git", a, { cwd: dir, stdio: ["ignore", "ignore", "ignore"] });
  git("init", "-q");
  git("config", "user.email", "t@t");
  git("config", "user.name", "t");
  git("add", "-A");
  git("commit", "-qm", "seed");
  /** 커밋한 뒤 내용을 바꾼다 — 그래야 ' M ' 상태로 줄 하나씩 나온다. */
  for (let i = 0; i < n; i++) writeFileSync(path.join(sub, NAME_POOL(i)), "x\ny\n");
  return 0;
};

function makeFixture(root, targetBytes, build, countOf, measure) {
  const dir = path.join(root, `fx-${targetBytes}-${build.id}`);
  mkdirSync(dir, { recursive: true });
  const { perLine } = calibrate(build, measure);
  const count      = Math.max(1, Math.round(targetBytes / perLine));
  build(dir, count);
  const made = countOf(dir);
  if (made !== count) {
    throw new Error(`fixture 생성 실패: 요청 ${count}개 중 ${made}개만 만들어졌다 (출력 크기 축의 숫자가 아니다)`);
  }
  return { dir, files: count, perLine };
}

function engineFor(dir, maxConcurrency) {
  const config = structuredClone(DEFAULT_CONFIG);
  config.guard.allowed_paths = [dir];
  config.guard.max_concurrency = maxConcurrency;
  /** 수집 상한이 크기 측정보다 먼저 걸리면 비교가 되지 않는다. 목표의 8배로 올린다. */
  config.guard.max_output_bytes = 8 * 1024 * 1024;
  /** 가산정 하한(500)은 'max_items 절단'이 '크기' 측정과 섞이게 하므로 올린다. 상한에 걸린 숫자는 버린다. */
  config.guard.max_items = 200_000;
  /**
   * 적응형 포맷은 행 수를 보고 raw 를 떼어 낸다. 성능 비교에서 원문 처리 비용이 축이므로 끈다.
   * `src/facade/engine.ts` 의 판정이 `threshold.json_no_raw > 0 && ...` 이므로 **0 은 비활성화**다.
   * 덧붙여 근거나 예산을 요청한 경로는 애초에 이 분기를 건너뛴다(`!wantEvidence && !opts?.budget`).
   */
  config.parsers = { ...config.parsers, adaptive_format_threshold: { json: 0, compact: 0, json_no_raw: 0 } };
  return new ParismEngine(config, createRegistry());
}

const OFF_ARGS = {};
const ON_ARGS  = {
  contract_version: "next", evidence: "rows", retain: true,
  budget: { max_tokens: 20_000, required_fields: ["name", "size_bytes", "type"] },
};

/**
 * off/on 을 **같은 반복 안에서 번갈아** 뛴다.
 * off 를 12회 다 끝내고 나서 on 을 12회 도는 식으로 하면 나중에 도는 쪽이 캐시·CPU 상태에서
 * 유리해진다. 순서 효과(measurement drift)를 지우려고 한 회차마다 off 묶음과 on 묶음을 붙여 뛴다.
 *
 * concurrency 는 `guard.max_concurrency` 값만 바꾸면 아무 효과가 없다 — 한 번에 명령 하나씩 부르면
 * 세마포어가 늘어도 지내는 일은 같다. 그래서 concurrency 개를 **실제로 동시에** 건다.
 */
async function measurePair(engine, conc, cmd, args, cwd, warmup, repeat, label) {
  const acc = {
    off: { perOp: [], batch: [] }, on: { perOp: [], batch: [] },
  };
  let peakRss = 0;
  let rssBeforeOn = 0;
  let lastOn = undefined;

  const oneRun = async extra => {
    const t = process.hrtime.bigint();
    const r = await engine.run(cmd, { args, cwd, ...extra });
    return { ms: Number(process.hrtime.bigint() - t) / 1e6, result: r };
  };

  for (let i = 0; i < warmup + repeat; i++) {
    const turn = i >= warmup;
    const runBatch = async extra => {
      const t0    = process.hrtime.bigint();
      const batch = await Promise.all(Array.from({ length: conc }, () => oneRun(extra)));
      const wall  = Number(process.hrtime.bigint() - t0) / 1e6;
      return { wall, batch };
    };

    const offRun = await runBatch(OFF_ARGS);
    if (turn) {
      rssBeforeOn = process.memoryUsage().rss;
      peakRss     = Math.max(peakRss, rssBeforeOn);
    }
    const onRun = await runBatch(ON_ARGS);
    lastOn    = onRun.batch[0]?.result;
    peakRss   = Math.max(peakRss, process.memoryUsage().rss);

    if (turn) {
      for (const b of offRun.batch) { acc.off.perOp.push(b.ms); acc.off.batch.push(offRun.wall); }
      for (const b of onRun.batch)  { acc.on.perOp.push(b.ms);  acc.on.batch.push(onRun.wall); }
      if (process.stdout.isTTY) {
        process.stdout.write(`\r    ${label} ${i - warmup + 1}/${repeat}   `);
      }
    }
  }
  if (process.stdout.isTTY) process.stdout.write("\r" + " ".repeat(60) + "\r");

  const pack = a => {
    const wallTotal = a.batch.reduce((x, y) => x + y, 0);
    return { latency: stats(a.perOp), throughput: (a.perOp.length) / (wallTotal / 1000) };
  };
  return { off: pack(acc.off), on: pack(acc.on), peakRss, rssBeforeOn, lastOn };
}

const root = mkdtempSync(path.join(tmpdir(), "parism-perf-"));
/** 계획서 10장이 명시한 세 크기. */
const SIZES      = [1024, 100 * 1024, 1024 * 1024];
const CONCURRENCY = [1, 4, 16];
const WARMUP     = Number(process.env.PERF_WARMUP ?? 2);
const REPEAT     = Number(process.env.PERF_REPEAT ?? 10);

const onlyArg = process.argv.find(a => a.startsWith("--only="));
const only    = onlyArg ? new Set(onlyArg.slice("--only=".length).split(",").map(s => s.trim().toLowerCase())) : null;
const sizeLabel = n => n >= 1024 * 1024 ? `${n / (1024 * 1024)}MB` : `${n / 1024}KB`;
const sizes     = SIZES.filter(n => !only || only.has(sizeLabel(n).toLowerCase()));

/**
 * 두 명령을 따로 재는 이유 — **명령마다 on 경로가 실제로 하는 일이 다르다.**
 *
 * 필드 근거를 만드는 파서는 `git status --porcelain` 과 `ps` 뿐이다(registry 에 등록된 evidence 빌더).
 * `ls` 로만 재면 on 경로의 가장 무거운 비용(근거 지构筑)이 측정에서 빠지고,
 * '근거를 켜도 파김이나 보관 비용 정도다' 라는 잘못된 결론이 나온다.
 * 그래서 파싱·보관 비용을 보는 `ls` 와 실제 근거 구축 비용을 보는 `git status` 를 나란히 놓는다.
 */
const COMMANDS = [
  {
    id: "ls", label: "ls -l", cmd: "ls", args: ["-l"],
    build: lsFixture, countOf: dir => readdirSync(dir).filter(f => f.endsWith(".ts")).length,
    measure: dir => execFileSync("ls", ["-l"], { cwd: dir, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 }),
    note: "필드 근거를 내지 않는 파서 — 이 행의 on 비용은 파싱·보관·예산 비용이다",
  },
  {
    id: "git", label: "git status --porcelain", cmd: "git", args: ["status", "--porcelain"],
    build: gitFixture, countOf: dir => readdirSync(path.join(dir, LONG_DIR)).filter(f => f.endsWith(".ts")).length,
    measure: dir => execFileSync("git", ["status", "--porcelain"], { cwd: dir, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 }),
    note: "필드 근거를 실제로 만드는 파서 — 여기가 근거 구축 비용이 드러나는 자리다",
  },
];

console.log("=".repeat(78));
console.log("  성능 게이트 — 새 기능 off vs on");
console.log("=".repeat(78));
console.log(`\n기준: 같은 커밋의 두 코드 경로. warmup ${WARMUP}회 × conc 개 동시, 측정 ${REPEAT}회 (off/on 교대)`);
console.log(`크기: ${sizes.map(sizeLabel).join(", ")} × concurrency ${CONCURRENCY.join(", ")}`);
console.log(`host: node ${process.version} · ${process.platform}/${process.arch} · ${cpus().length} cpu`);
console.log(`단위: 개당 지연은 한 명령의 벽시계, throughput 은 완료 건수/초\n`);

const report = [];
try {
  for (const spec of COMMANDS) {
    console.log(`${"#".repeat(78)}`);
    console.log(`  명령: ${spec.label}`);
    console.log(`  ${spec.note}`);
    console.log(`${"#".repeat(78)}\n`);

    for (const size of sizes) {
      const { dir, files, perLine } = makeFixture(root, size, spec.build, spec.countOf, spec.measure);

      /** 실제 출력이 목표 크기 근처인지 parism 으로 확인한다 — fixture 가 틀리면 숫자도 틀린다. */
      const probe    = engineFor(dir, 1);
      const one      = await probe.run(spec.cmd, { args: spec.args, cwd: dir });
      const outBytes = Buffer.byteLength(one.stdout.raw, "utf8");
      const ratio    = outBytes / size;
      const scored   = ratio >= 0.5 && ratio <= 2;
      const rows     = one.stdout.parsed?.entries?.length ?? 0;

      console.log(`  ${sizeLabel(size)} — 파일 ${files.toLocaleString()}개 · 한 줄 ${perLine.toFixed(1)}B`);
      console.log(`    실제 stdout ${outBytes.toLocaleString()}B = 목표의 ${(ratio * 100).toFixed(0)}% · ${approx(one.stdout.raw).toLocaleString()}토큰 근사 · 파싱 행 ${rows.toLocaleString()}`);
      console.log(`    잘림 ${one.truncated ?? "없음"} · 파싱 실패 ${one.failure ? one.failure.reason : "없음"} · ${scored ? "채점" : "채점하지 않음(목표에서 벗어남)"}`);
      if (!scored) { console.log(""); continue; }

      for (const conc of CONCURRENCY) {
        const engine = engineFor(dir, conc);
        const m = await measurePair(engine, conc, spec.cmd, spec.args, dir, WARMUP, REPEAT, `${spec.id} conc${conc}`);

        /** 저장 바이트 — 결과 하나만 들어 있는 새 엔진으로 재서 '결과당' 크기를 잰다. */
        const storeEngine = engineFor(dir, 1);
        const stored      = await storeEngine.run(spec.cmd, {
          args: spec.args, cwd: dir, contract_version: "next", evidence: "rows", retain: true,
        });
        // ResultStore.bytes 는 private 필드지만 컴파일 단계 제약일 뿐이라 측정에서 읽는다.
        const perResult   = storeEngine.results.bytes;
        /** 필드 근거가 실제로 만들어졌는지 — 안 만들어졌으면 이 칸의 on 비용을 근거 비용이라고 부를 수 없다. */
        const fieldEv     = !(stored.review?.warnings ?? []).some(w => w.includes("no field evidence"));
        const budgeted    = m.lastOn;
        const b           = budgeted?.budget;
        const omitted     = budgeted?.omission?.[0]?.rows_omitted ?? 0;
        const returned    = budgeted?.stdout.parsed?.entries?.length ?? 0;

        const dP50 = ((m.on.latency.p50 - m.off.latency.p50) / m.off.latency.p50) * 100;
        const dP95 = ((m.on.latency.p95 - m.off.latency.p95) / m.off.latency.p95) * 100;
        const dTp  = ((m.on.throughput - m.off.throughput) / m.off.throughput) * 100;

        console.log(`    concurrency ${conc}`);
        console.log(`      off  ${fmt(m.off.latency)}  ·  ${m.off.throughput.toFixed(1)} 건/초`);
        console.log(`      on   ${fmt(m.on.latency)}  ·  ${m.on.throughput.toFixed(1)} 건/초`);
        console.log(`      on 이 추가한 시간  p50 ${pct(dP50)} · p95 ${pct(dP95)} · throughput ${pct(dTp)}`);
        console.log(`      peak RSS ${kib(m.rssBeforeOn)} → ${kib(m.peakRss)} (on 구간 추가 ${kib(m.peakRss - m.rssBeforeOn)})`);
        console.log(`      저장 바이트 결과당 ${kib(perResult)} · retained=${stored.review?.retained} · 필드 근거 ${fieldEv ? "생성됨" : "없음"}`);
        if (b) {
          console.log(`      예산 measured=${b.measured_tokens.toLocaleString()} / max=${b.requested.max_tokens.toLocaleString()} · tokenizer=${b.requested.tokenizer ?? "?"} · budget_met=${b.budget_met}`);
          console.log(`      반환 ${returned.toLocaleString()}행 / 생략 ${omitted.toLocaleString()}행${omitted > 0 && returned === 0 ? "  ← 모든 행이 잘렸다" : ""}`);
        }
        if (stored.review?.warnings?.length) {
          console.log(`      review 경고: ${stored.review.warnings.join(" / ")}`);
        }
        if (budgeted?.failure) console.log(`      실행 실패: ${budgeted.failure.reason} — ${budgeted.failure.message ?? ""}`);

        report.push({ cmd: spec.id, size: sizeLabel(size), files, conc, outBytes, fieldEv, dP50, dP95, dTp, rssAdd: m.peakRss - m.rssBeforeOn, perResult, retained: stored.review?.retained });
        console.log("");
      }
    }
  }

  /** 표로 한 번에 — 사람이 읽는 지표다. */
  console.log("=".repeat(78));
  console.log("  정리 — 새 기능 on 이 같은 커밋의 기존 경로에 추가한 비용");
  console.log("=".repeat(78));
  for (const spec of COMMANDS) {
    const rowsFor = report.filter(r => r.cmd === spec.id);
    if (rowsFor.length === 0) continue;
    console.log(`\n  ${spec.label}`);
    console.log(`  크기     파일수   conc   p50 변화  p95 변화  throughput  RSS 추가   저장(결과당)  필드근거`);
    console.log(`  ${"-".repeat(96)}`);
    for (const r of rowsFor) {
      console.log(
        `  ${r.size.padEnd(8)} ${String(r.files.toLocaleString()).padStart(7)} ${String(r.conc).padStart(5)}   ` +
        `${pct(r.dP50).padStart(8)} ${pct(r.dP95).padStart(9)} ${pct(r.dTp).padStart(11)}  ` +
        `${kib(r.rssAdd).padStart(8)}   ${kib(r.perResult).padStart(9)}${r.retained ? "" : "*"}   ${r.fieldEv ? "생성됨" : "없음"}`,
      );
    }
  }

  console.log(`\n${"=".repeat(78)}`);
  console.log("  읽는 법");
  console.log(`${"=".repeat(78)}`);
  console.log(`
  - off/on 은 같은 커밋의 두 코드 경로다. 이전 커밋을 빌드해 비교하지 않는다 —
    빌드 차이와 코드 차이를 분리할 수 없기 때문이다.
  - '기능 off 회귀 없음' 을 보려면 off 경로가 이전 릴리스와 비교되어야 한다.
    이 스크립트는 같은 커밋 안의 on/off 차이만 재므로 그 판정은 하지 않는다.
  - 표본이 작다(묶음당 ${REPEAT}회). p95 는 최댓값에 가깝고 CPU 상태에 따라 움직인다.
    여기서 통과/실패를 선언하지 않는다.
  - off 과 on 을 한 회차마다 번갈아 뛴다. 그래도 같은 프로세스 안에서 돌아간다는 한계는 남는다.
  - RSS 는 이 프로세스 값이다. 'RSS 추가' 는 on 구간 시작 시점 대비 on 구간 고점의 차이다.
    자식 프로세스 메모리를 합한 값이 아니다.
  - 워커 CPU 는 측정하지 못했다. 외부 ParserPack 이 있어야 측정되는 값이고 이 실험에는 없다.
  - '*' 는 보관 한도(결과당 2MiB)에 걸려 retained=false 가 된 경우다.
  - 10% 는 출시 판정을 위한 초기 예산이지 측정값이 아니다.
  `);
} finally {
  rmSync(root, { recursive: true, force: true });
}
