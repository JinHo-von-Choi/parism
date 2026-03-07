import { runScenario }               from "./runner.js";
import { printReport }               from "./reporter.js";
import { lsNormalScenario,
         lsSpacesScenario }          from "./scenarios/ls.bench.js";
import { psScenario }                from "./scenarios/ps.bench.js";
import { gitLogScenario }            from "./scenarios/git.bench.js";
import { dfLinuxScenario,
         dfMacosScenario }           from "./scenarios/df.bench.js";
import { statLinuxScenario,
         statMacosScenario }         from "./scenarios/stat.bench.js";
import { netstatLinuxScenario,
         netstatMacosScenario }      from "./scenarios/netstat.bench.js";
import { lsMediumMixedScenario,
         lsLargeMixedScenario }      from "./scenarios/ls-scale.bench.js";
import { psProductionScenario }      from "./scenarios/ps-production.bench.js";
import { kubectlClusterScenario }    from "./scenarios/kubectl.bench.js";
import { dockerFleetScenario }       from "./scenarios/docker.bench.js";
import { gitDiffScenario }           from "./scenarios/git-diff.bench.js";
import { kubectlLogsScenario }       from "./scenarios/kubectl-logs.bench.js";
import type { BenchmarkReport }      from "./types.js";

const SCENARIOS = [
  // ── 기존 시나리오 (소규모 기준선) ──────────────────────────────
  lsNormalScenario,
  lsSpacesScenario,
  psScenario,
  gitLogScenario,
  dfLinuxScenario,
  dfMacosScenario,
  statLinuxScenario,
  statMacosScenario,
  netstatLinuxScenario,
  netstatMacosScenario,
  // ── 대규모 시나리오 (역전 구간 탐색) ──────────────────────────
  lsMediumMixedScenario,
  lsLargeMixedScenario,
  psProductionScenario,
  kubectlClusterScenario,
  dockerFleetScenario,
  // ── 비정형 텍스트 시나리오 (Parism 파서 없는 케이스) ────────────────────
  gitDiffScenario,
  kubectlLogsScenario,
];

async function main(): Promise<void> {
  console.log("Running Parism benchmark...");

  const results = await Promise.all(SCENARIOS.map(runScenario));

  const totalRaw  = results.reduce(
    (acc, r) => acc + r.rawOutputTokens  + r.rawContextTokens,  0
  );
  const totalJson = results.reduce(
    (acc, r) => acc + r.jsonOutputTokens + r.jsonContextTokens, 0
  );
  const rawSuccesses  = results.filter(r => r.rawExtraction.success).length;
  const jsonSuccesses = results.filter(r => r.jsonExtraction.success).length;

  const report: BenchmarkReport = {
    runAt:    new Date().toISOString(),
    scenarios: results,
    summary: {
      totalRawTokens:           totalRaw,
      totalJsonTokens:          totalJson,
      rawSuccessRate:           rawSuccesses  / results.length,
      jsonSuccessRate:          jsonSuccesses / results.length,
      avgCfr:                   results.reduce((a, r) => a + r.cfr, 0) / results.length,
      totalDollarCostRaw:       results.reduce((a, r) => a + r.dollarCostRaw, 0),
      totalDollarCostParsedOnly: results.reduce((a, r) => a + r.dollarCostJsonParsedOnly, 0),
      avgExecTimeMs:            results.reduce((a, r) => a + r.execTimeMs, 0) / results.length,
    },
  };

  printReport(report);
}

main().catch(err => {
  console.error("Benchmark failed:", err);
  process.exit(1);
});
