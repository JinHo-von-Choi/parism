import type { BenchmarkReport, ScenarioResult } from "./types.js";

function formatDelta(base: number, target: number): string {
  const delta   = target - base;
  const percent = base > 0 ? ((delta / base) * 100).toFixed(1) : "N/A";
  const sign    = delta >= 0 ? "+" : "";
  return `${sign}${delta} (${sign}${percent}%)`;
}

function row(label: string, without: string, withP: string, delta: string): string {
  return `  ${label.padEnd(32)} ${without.padEnd(16)} ${withP.padEnd(16)} ${delta}`;
}

function printScenario(r: ScenarioResult): void {
  const totalRaw  = r.rawOutputTokens  + r.rawContextTokens;
  const totalJson = r.jsonOutputTokens + r.jsonContextTokens;
  const sep       = "  " + "─".repeat(82);

  console.log(`\n┌─ ${r.name}`);
  console.log(`│  ${r.description}`);
  console.log(sep);
  console.log(row("Metric", "Without Parism", "With Parism", "Delta"));
  console.log(sep);
  console.log(row(
    "Output tokens (raw/JSON)",
    String(r.rawOutputTokens),
    String(r.jsonOutputTokens),
    formatDelta(r.rawOutputTokens, r.jsonOutputTokens),
  ));
  console.log(row(
    "Context prompt tokens",
    String(r.rawContextTokens),
    String(r.jsonContextTokens),
    formatDelta(r.rawContextTokens, r.jsonContextTokens),
  ));
  console.log(row(
    "TOTAL cost (output + ctx)",
    String(totalRaw),
    String(totalJson),
    formatDelta(totalRaw, totalJson),
  ));
  console.log(row(
    "Parse success",
    r.rawExtraction.success ? "✓ yes" : "✗ no",
    r.jsonExtraction.success ? "✓ yes" : "✗ no",
    r.rawExtraction.success === r.jsonExtraction.success ? "(same)" : "← DIFF",
  ));
  console.log(row(
    "Extract time (ms)",
    String(r.rawExtraction.timeMs),
    String(r.jsonExtraction.timeMs),
    "",
  ));
  if (!r.rawExtraction.success && r.rawExtraction.errorMsg) {
    console.log(`  ✗ raw error: ${r.rawExtraction.errorMsg}`);
  }
}

export function printReport(report: BenchmarkReport): void {
  const W = 86;
  const line = "═".repeat(W);

  console.log("\n" + line);
  console.log("  PARISM BENCHMARK — Token Cost & Reliability Comparison");
  console.log(`  ${report.runAt}`);
  console.log(line);
  console.log(row("", "Without Parism", "With Parism", ""));
  console.log(line);

  for (const scenario of report.scenarios) {
    printScenario(scenario);
  }

  const s = report.summary;
  console.log("\n" + line);
  console.log("  SUMMARY");
  console.log(line);
  console.log(row(
    "Total output tokens",
    String(s.totalRawTokens),
    String(s.totalJsonTokens),
    formatDelta(s.totalRawTokens, s.totalJsonTokens),
  ));
  console.log(row(
    "Parse success rate",
    `${(s.rawSuccessRate  * 100).toFixed(0)}%`,
    `${(s.jsonSuccessRate * 100).toFixed(0)}%`,
    s.jsonSuccessRate > s.rawSuccessRate ? "← Parism wins" : "(same)",
  ));
  console.log("\n  Interpretation:");
  console.log("  • 'Output tokens' measures what the LLM sees in context.");
  console.log("  • Parism JSON is larger — but includes raw (always) + structured parsed.");
  console.log("  • 'Context prompt tokens' = instructions needed to guide LLM to parse output.");
  console.log("  • Raw text requires verbose field-order explanations; JSON is self-describing.");
  console.log("  • TOTAL = output + context. This is the true cost comparison.");
  console.log("  • Parse failures trigger retries → multiplies total cost by (1 + failRate × retries).");
  console.log(line + "\n");
}
