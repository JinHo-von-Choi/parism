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
import type { BenchmarkReport }      from "./types.js";

const SCENARIOS = [
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
      totalRawTokens:  totalRaw,
      totalJsonTokens: totalJson,
      rawSuccessRate:  rawSuccesses  / results.length,
      jsonSuccessRate: jsonSuccesses / results.length,
    },
  };

  printReport(report);
}

main().catch(err => {
  console.error("Benchmark failed:", err);
  process.exit(1);
});
