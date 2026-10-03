/**
 * 외부 ParserPack 실행 지연 측정: 서버 스레드 실행(isolation=none)과 워커 격리 실행(isolation=worker).
 * 같은 팩과 같은 입력으로 호출 지연(평균, p50, p99), 워커 기동 비용, 실패 뒤 다시 띄우는 호출의 비용을 잰다.
 * 실행: npm run benchmark:external
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 */

import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join }                               from "node:path";
import { tmpdir }                             from "node:os";
import { ParserRegistry }                     from "../src/parsers/registry.js";
import { loadIsolatedPack }                   from "../src/parsers/external/host.js";
import { loadParserPack }                     from "../src/cli/loader.js";
import { EXTERNAL_PARSER_DEFAULTS }           from "../src/config/loader.js";

const WARMUP_CALLS   = 200;
const MEASURED_CALLS = 2000;
const STARTUP_RUNS   = 10;

/** 재기동 비용을 바로 재도록 장애 뒤 대기 시간은 두지 않는다. 호출 지연에는 영향이 없다. */
const LIMITS = {
  timeLimitMs:   EXTERNAL_PARSER_DEFAULTS.external_time_limit_ms,
  memoryLimitMb: EXTERNAL_PARSER_DEFAULTS.external_memory_limit_mb,
  cooldownMs:    0,
};

/** 공백으로 나눈 열을 이름 붙인 행으로 바꾸는 작은 팩. "stop" 입력은 끝나지 않는다(재기동 측정용). */
const PACK_SOURCE = `
  export default {
    name: "bench",
    parse(raw) {
      if (raw === "stop") for (;;) {}
      const rows = raw.split("\\n").filter(Boolean).map(line => {
        const [name, size, owner] = line.split(/\\s+/);
        return { name, size_bytes: Number(size), owner };
      });
      return { entries: rows };
    },
    schema: {},
    fixtures: [],
    rowsKey: "entries",
  };
`;

/** 작은 입력(20줄)과 중간 입력(500줄) */
function makeInput(lines: number): string {
  return Array.from({ length: lines }, (_, i) => `file-${i}.txt ${1000 + i} user${i % 3}`).join("\n") + "\n";
}

interface LatencyStats {
  meanUs: number;
  p50Us:  number;
  p99Us:  number;
}

function percentile(sorted: number[], p: number): number {
  const index = Math.min(sorted.length - 1, Math.floor(sorted.length * p));
  return sorted[index]!;
}

/** 호출 지연(마이크로초) 통계 */
function measure(fn: () => void): LatencyStats {
  for (let i = 0; i < WARMUP_CALLS; i++) fn();
  const samples: number[] = [];
  for (let i = 0; i < MEASURED_CALLS; i++) {
    const start = performance.now();
    fn();
    samples.push((performance.now() - start) * 1000);
  }
  samples.sort((a, b) => a - b);
  const mean = samples.reduce((sum, v) => sum + v, 0) / samples.length;
  return { meanUs: mean, p50Us: percentile(samples, 0.5), p99Us: percentile(samples, 0.99) };
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)]!;
}

function fmt(n: number): string {
  return n.toFixed(1).padStart(9);
}

async function main(): Promise<void> {
  const packDir = mkdtempSync(join(tmpdir(), "parism-bench-pack-"));
  writeFileSync(join(packDir, "parser.js"), PACK_SOURCE);

  const inProcess = new ParserRegistry();
  inProcess.registerPack(await loadParserPack(packDir));
  const isolated  = new ParserRegistry();
  isolated.registerIsolated(loadIsolatedPack(packDir, LIMITS));

  try {
    console.log("External ParserPack parse latency (microseconds per call)");
    console.log(`warmup ${WARMUP_CALLS}, measured ${MEASURED_CALLS} calls, Node ${process.version}\n`);
    console.log("input         mode          mean       p50       p99");
    for (const [label, lines] of [["small (20)", 20], ["medium (500)", 500]] as const) {
      const raw = makeInput(lines);
      for (const [mode, registry] of [["in-process", inProcess], ["worker", isolated]] as const) {
        if (registry.parse("bench", [], raw).parsed == null) throw new Error(`${mode} parse failed`);
        const stats = measure(() => registry.parse("bench", [], raw));
        console.log(`${label.padEnd(14)}${mode.padEnd(11)}${fmt(stats.meanUs)} ${fmt(stats.p50Us)} ${fmt(stats.p99Us)}`);
      }
    }

    const startups: number[] = [];
    for (let i = 0; i < STARTUP_RUNS; i++) {
      const start = performance.now();
      const pack  = loadIsolatedPack(packDir, LIMITS);
      startups.push(performance.now() - start);
      await pack.close();
    }
    console.log(`\nworker startup (spawn + module load), median of ${STARTUP_RUNS}: ${median(startups).toFixed(1)} ms`);

    const small     = makeInput(20);
    const respawns: number[] = [];
    for (let i = 0; i < 3; i++) {
      isolated.parse("bench", [], "stop");
      const start  = performance.now();
      const result = isolated.parse("bench", [], small);
      respawns.push(performance.now() - start);
      if (result.parsed == null) throw new Error(`respawn call failed: ${result.parse_error?.message ?? "no result"}`);
    }
    console.log(`first call after a time-limit stop (respawn + parse), median of 3: ${median(respawns).toFixed(1)} ms`);
  } finally {
    await isolated.close();
    rmSync(packDir, { recursive: true, force: true });
  }
}

main().catch(err => {
  console.error("Benchmark failed:", err);
  process.exit(1);
});
