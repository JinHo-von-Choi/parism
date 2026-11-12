/**
 * `parism stats`, `parism doctor`, `parism receipts export` 시험.
 *
 * 작성자: 최진호
 * 작성일: 2026-11-12
 */

import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { formatStats, parseSince, summarizeStats } from "../../src/cli/stats.js";
import { runDoctor } from "../../src/cli/doctor.js";
import { formatExportMarkdown, formatExportSarif, type ExportSummary } from "../../src/cli/receipts.js";
import type { StatsEvent } from "../../src/engine/stats-log.js";

const t = "2026-11-12T00:00:00.000Z";

describe("stats", () => {
  it("기록을 종류별로 모은다", () => {
    const events: StatsEvent[] = [
      { t, kind: "run", cmd: "ls", outcome: "parsed", raw_tokens: 1000, delivered_tokens: 300, auto_retained: true },
      { t, kind: "run", cmd: "ls", outcome: "parsed", raw_tokens: 100, delivered_tokens: 150, redactions: 2, pipe: "rows" },
      { t, kind: "guard_block", cmd: "git", outcome: "arg_not_allowed" },
      { t, kind: "shell_reject", cmd: "ls", outcome: ">" },
      { t, kind: "query", hit: true }, { t, kind: "query", hit: false },
      { t, kind: "stop_block" }, { t, kind: "stop_pass" }, { t, kind: "hook_rewrite", cmd: "git" }, { t, kind: "hook_block", cmd: "git" },
    ];
    const r = summarizeStats(events, 3);
    expect(r).toMatchObject({
      runs: 2, raw_tokens: 1100, delivered_tokens: 450, saved_tokens: 650, auto_retained: 1,
      requeries: { total: 2, hits: 1 }, redactions: { runs: 1, spans: 2 }, guard_blocks: { total: 1 },
      shell_rejects: { total: 1, by_operator: { ">": 1 } }, pipes: { rows: 1, text: 0 },
      stop_gate: { blocked: 1, passed: 1 }, hook: { rewritten: 1, blocked: 1 },
    });
    expect(r.top_blocked).toEqual([{ cmd: "git", count: 2 }]);
    expect(r.saved_usd).toBeCloseTo(650 * 3 / 1e6, 6);
    expect(formatStats(r)).toMatch(/tokens saved\s+650/);
  });

  it("since를 읽는다", () => {
    expect(parseSince("7d", 10 * 86_400_000)).toBe(3 * 86_400_000);
    expect(parseSince("2026-01-01")).toBe(Date.parse("2026-01-01"));
    expect(() => parseSince("yesterday-ish")).toThrow(/use 7d/);
  });
});

describe("doctor", () => {
  it("output_patterns: []와 꺼진 리댁션을 알린다", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "parism-doc-"));
    const file = path.join(dir, "c.json");
    writeFileSync(file, JSON.stringify({ guard: { allowed_paths: [dir], secrets: { output_patterns: [] } } }));
    const r = await runDoctor({ config: file, cwd: dir });
    expect(r.ok).toBe(false);
    expect(r.checks.map(c => c.id)).toEqual(expect.arrayContaining(["redaction_off", "empty_output_patterns", "native_regex", "hooks"]));
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("receipts export 형식", () => {
  const summary: ExportSummary = {
    generated_at: t, cwd: "/w", receipts: 2,
    commands: [{ command: "npx vitest run", runs: 2, last_exit: 1, last_at: t, summary: "3 passed, 1 failed, 0 skipped", fresh: true }],
    tests: { passed: 3, failed: 1, skipped: 0 }, diagnostics: { errors: 0, warnings: 0 },
    failed_runs: [{ command: "npx vitest run", at: t, detail: "exit code 1, 1 failed test(s)", id: "rcp_1" }], failed_runs_total: 1,
    workspace: { git_head: "abc123", state_digest: "d" }, fresh: true,
    chain: { ok: false, entries: 2, signed: true, problems: [{ line: 2, reason: "chain_broken", detail: "prev does not match" }] },
    guard_blocks: 1, blocked_commands: [], saved_tokens: 1234,
  };

  it("markdown은 표와 실패 목록을 싣는다", () => {
    const md = formatExportMarkdown(summary);
    expect(md).toContain("| tests | 3 passed, 1 failed, 0 skipped |");
    expect(md).toContain("| receipt chain and signatures intact | no |");
    expect(md).toContain("`npx vitest run` at");
  });

  it("SARIF 2.1.0 결과로 실패와 체인 문제를 낸다", () => {
    const sarif = JSON.parse(formatExportSarif(summary, "3.0.0"));
    expect(sarif.version).toBe("2.1.0");
    expect(sarif.runs[0].results.map((r: { ruleId: string }) => r.ruleId)).toEqual(["parism/failed-run", "parism/receipt-integrity"]);
  });
});
