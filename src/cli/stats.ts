/**
 * `parism stats`: 사용 통계 기록(~/.parism/stats/events.jsonl)을 모아 보여 준다.
 *
 * 토큰 수는 parism/approx 토크나이저의 추정치다. 비용은 입력 토큰 단가를 곱한 추정치이며
 * 단가는 --price로 바꾼다(기본 1백만 토큰당 3달러).
 *
 * 작성자: 최진호
 * 작성일: 2026-11-12
 */

import path                      from "node:path";
import { DEFAULT_STATS, loadConfig, loadConfigMultiLayer } from "../config/loader.js";
import { StatsLog, type StatsEvent } from "../engine/stats-log.js";
import { parismHome }            from "./paths.js";

export interface StatsReport {
  since?:          string;
  events:          number;
  runs:            number;
  by_outcome:      Record<string, number>;
  raw_tokens:      number;
  delivered_tokens: number;
  /** 원문을 그대로 냈을 때보다 줄어든 토큰. 음수면 늘었다. */
  saved_tokens:    number;
  saved_ratio:     number;
  saved_usd:       number;
  price_per_mtok:  number;
  /** 결과 보관함에 자동으로 넣은 실행 수 */
  auto_retained:   number;
  /** 재실행 없이 보관 결과를 다시 읽은 횟수와 그 가운데 찾은 횟수 */
  requeries:       { total: number; hits: number };
  redactions:      { runs: number; spans: number };
  guard_blocks:    { total: number; by_reason: Record<string, number> };
  shell_rejects:   { total: number; by_operator: Record<string, number> };
  pipes:           { rows: number; text: number };
  stop_gate:       { blocked: number; passed: number };
  hook:            { rewritten: number; blocked: number };
  /** 가드가 가장 자주 막은 명령 */
  top_blocked:     { cmd: string; count: number }[];
  top_commands:    { cmd: string; runs: number; saved_tokens: number }[];
}

/** "7d", "24h", "30m" 또는 ISO 날짜를 ms epoch로 바꾼다 */
export function parseSince(value: string | undefined, now = Date.now()): number | undefined {
  if (!value) return undefined;
  const m = /^([0-9]+)([dhm])$/.exec(value.trim());
  if (m) return now - Number(m[1]) * { d: 86_400_000, h: 3_600_000, m: 60_000 }[m[2] as "d" | "h" | "m"];
  const t = Date.parse(value);
  if (Number.isNaN(t)) throw new Error(`--since ${value}: use 7d, 24h, 30m or a date`);
  return t;
}

function bump(table: Record<string, number>, key: string | undefined, n = 1): void {
  const k = key ?? "(none)";
  table[k] = (table[k] ?? 0) + n;
}

export function summarizeStats(events: readonly StatsEvent[], pricePerMTok = 3, since?: number): StatsReport {
  const report: StatsReport = {
    ...(since !== undefined && { since: new Date(since).toISOString() }),
    events: events.length, runs: 0, by_outcome: {}, raw_tokens: 0, delivered_tokens: 0, saved_tokens: 0, saved_ratio: 0,
    saved_usd: 0, price_per_mtok: pricePerMTok, auto_retained: 0, requeries: { total: 0, hits: 0 },
    redactions: { runs: 0, spans: 0 }, guard_blocks: { total: 0, by_reason: {} }, shell_rejects: { total: 0, by_operator: {} },
    pipes: { rows: 0, text: 0 }, stop_gate: { blocked: 0, passed: 0 }, hook: { rewritten: 0, blocked: 0 },
    top_blocked: [], top_commands: [],
  };
  const blocked  = new Map<string, number>();
  const commands = new Map<string, { runs: number; saved: number }>();
  for (const e of events) {
    switch (e.kind) {
      case "run": {
        report.runs++;
        bump(report.by_outcome, e.outcome);
        const raw = e.raw_tokens ?? 0;
        const out = e.delivered_tokens ?? 0;
        report.raw_tokens       += raw;
        report.delivered_tokens += out;
        if (e.auto_retained) report.auto_retained++;
        if (e.redactions) { report.redactions.runs++; report.redactions.spans += e.redactions; }
        if (e.pipe) report.pipes[e.pipe]++;
        const c = commands.get(e.cmd ?? "(unknown)") ?? { runs: 0, saved: 0 };
        c.runs++;
        c.saved += raw - out;
        commands.set(e.cmd ?? "(unknown)", c);
        break;
      }
      case "query":        report.requeries.total++; if (e.hit) report.requeries.hits++; break;
      case "guard_block":  report.guard_blocks.total++; bump(report.guard_blocks.by_reason, e.outcome); blocked.set(e.cmd ?? "(unknown)", (blocked.get(e.cmd ?? "(unknown)") ?? 0) + 1); break;
      case "shell_reject": report.shell_rejects.total++; bump(report.shell_rejects.by_operator, e.outcome); break;
      case "stop_block":   report.stop_gate.blocked++; break;
      case "stop_pass":    report.stop_gate.passed++; break;
      case "hook_rewrite": report.hook.rewritten++; break;
      case "hook_block":   report.hook.blocked++; blocked.set(e.cmd ?? "(unknown)", (blocked.get(e.cmd ?? "(unknown)") ?? 0) + 1); break;
    }
  }
  report.saved_tokens = report.raw_tokens - report.delivered_tokens;
  report.saved_ratio  = report.raw_tokens > 0 ? report.saved_tokens / report.raw_tokens : 0;
  report.saved_usd    = Math.round(report.saved_tokens * pricePerMTok) / 1e6;
  report.top_blocked  = [...blocked].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([cmd, count]) => ({ cmd, count }));
  report.top_commands = [...commands].sort((a, b) => b[1].runs - a[1].runs).slice(0, 10).map(([cmd, c]) => ({ cmd, runs: c.runs, saved_tokens: c.saved }));
  return report;
}

export async function readStats(options: { since?: string; config?: string; price?: number } = {}): Promise<StatsReport> {
  const config = options.config ? await loadConfig(options.config) : await loadConfigMultiLayer();
  const stats  = config.stats ?? DEFAULT_STATS;
  const log    = new StatsLog(path.join(parismHome(), "stats"), stats.max_entries);
  const since  = parseSince(options.since);
  return summarizeStats(log.read(since), options.price ?? 3, since);
}

const n = (v: number) => v.toLocaleString("en-US");

export function formatStats(r: StatsReport): string {
  const pct = (v: number) => `${(v * 100).toFixed(1)}%`;
  const lines = [
    `Parism usage${r.since ? ` since ${r.since}` : ""} (${n(r.events)} events)`,
    "",
    `runs                 ${n(r.runs)}  (${Object.entries(r.by_outcome).map(([k, v]) => `${k} ${n(v)}`).join(", ") || "none"})`,
    `tokens, raw output   ${n(r.raw_tokens)}`,
    `tokens, delivered    ${n(r.delivered_tokens)}`,
    `tokens saved         ${n(r.saved_tokens)} (${pct(r.saved_ratio)}), about $${r.saved_usd.toFixed(4)} at $${r.price_per_mtok}/M input tokens`,
    `kept automatically   ${n(r.auto_retained)} large result(s)`,
    `re-queries           ${n(r.requeries.total)} (${n(r.requeries.hits)} answered without re-running)`,
    `secret redaction     ${n(r.redactions.spans)} span(s) in ${n(r.redactions.runs)} run(s)`,
    `pipe stages          ${n(r.pipes.rows)} on parsed rows, ${n(r.pipes.text)} on text`,
    `guard blocks         ${n(r.guard_blocks.total)}${r.guard_blocks.total > 0 ? ` (${Object.entries(r.guard_blocks.by_reason).map(([k, v]) => `${k} ${n(v)}`).join(", ")})` : ""}`,
    `shell syntax refused ${n(r.shell_rejects.total)}${r.shell_rejects.total > 0 ? ` (${Object.entries(r.shell_rejects.by_operator).map(([k, v]) => `${k} ${n(v)}`).join(", ")})` : ""}`,
    `hook                 ${n(r.hook.rewritten)} Bash call(s) run through Parism, ${n(r.hook.blocked)} blocked`,
    `stop gate            ${n(r.stop_gate.blocked)} unverified finish(es) blocked, ${n(r.stop_gate.passed)} passed`,
  ];
  if (r.top_commands.length > 0) {
    lines.push("", "most run commands");
    for (const c of r.top_commands) lines.push(`  ${c.cmd.padEnd(14)} ${n(c.runs).padStart(6)} runs  ${n(c.saved_tokens).padStart(10)} tokens saved`);
  }
  if (r.top_blocked.length > 0) {
    lines.push("", "most blocked commands");
    for (const c of r.top_blocked) lines.push(`  ${c.cmd.padEnd(14)} ${n(c.count).padStart(6)}`);
  }
  return lines.join("\n");
}
