#!/usr/bin/env node
/**
 * 장기 실행 태스크 실험 -- 실행 시간 제한(10초)을 넘는 시험을 에이전트가 끝까지 다루는가.
 *
 * 시험 전체에 80초쯤 걸리는 Rust 크레이트를 만들고, 에이전트에게 시험을 돌려 결과를 보고하게 한다.
 * 세 조건은 도구와 시간 제한만 다르다(experiments/long-task/server.mjs).
 *
 *   wait      -- run 도구만 있다. 실행 시간 제한 10초
 *   wait-long -- run 도구만 있다. 실행 시간 제한 10분
 *   task      -- run(mode: "task")과 task 도구가 있다. 실행 시간 제한 10초
 *
 * 크레이트는 두 종류다. failing은 시험 하나가 시작하자마자 실패하고, passing은 전부 통과한다.
 *
 * 재는 값:
 *   성공 -- failing은 실패한 시험의 이름을, passing은 실패가 없다는 것을 맞게 보고했는가
 *   실패를 안 시각 -- 실패한 시험의 이름이 도구 결과에 처음 나온 때까지 걸린 시간(failing만)
 *   세션 시간, 도구 호출 수, 취소 여부
 *
 * 사용:
 *   npm run build
 *   node experiments/long-task.mjs
 *
 * 환경 변수:
 *   PARISM_LONGTASK_MODEL    에이전트 모델 (기본 haiku)
 *   PARISM_LONGTASK_REPEATS  조건과 크레이트 종류마다 반복 횟수 (기본 5)
 *   PARISM_LONGTASK_PARALLEL 동시에 돌리는 세션 수 (기본 6)
 *
 * cargo가 있어야 한다. 에이전트는 `claude -p`로 실행하고, 사용자 설정, 훅, 내장 도구를 뺀다.
 *
 * 작성자: 최진호
 * 작성일: 2026-11-11
 */

import { spawn }     from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { clearTimeout, setTimeout } from "node:timers";
import { tmpdir }    from "node:os";
import path          from "node:path";

const MODEL    = process.env.PARISM_LONGTASK_MODEL ?? "haiku";
const REPEATS  = Number(process.env.PARISM_LONGTASK_REPEATS ?? 5);
const PARALLEL = Number(process.env.PARISM_LONGTASK_PARALLEL ?? 6);
const HERE     = import.meta.dirname;
const SERVER   = path.join(HERE, "long-task", "server.mjs");
const ARMS     = ["wait", "wait-long", "task"];
const KINDS    = ["failing", "passing"];

const FAILING_TEST = "parses_negative_numbers";
const SLOW_TESTS   = [
  ["parses_zero", "0", 0], ["parses_one_digit", "7", 7], ["parses_two_digits", "42", 42], ["parses_large_number", "100000", 100000],
  ["parses_leading_zero", "007", 7], ["parses_max_small", "255", 255], ["parses_ten", "10", 10], ["parses_hundred", "100", 100],
  ["parses_thousand", "1000", 1000], ["parses_nine", "9", 9],
];

const SYSTEM_PROMPT =
  "You are a coding assistant working in a Rust crate. " +
  "Use the tools to execute commands in the crate. Answer the user's question concisely.";
const QUESTION = "Run this crate's test suite with `cargo test` and tell me which tests fail, by name. If none fail, say that all tests pass.";

/** 느린 시험은 잠금 하나를 차례로 잡고 8초씩 쉰다. 그래서 병렬로 시작해도 전체에 80초쯤 걸린다. */
function createCrate(kind) {
  const dir = mkdtempSync(path.join(tmpdir(), "parism-longtask-"));
  mkdirSync(path.join(dir, "src"));
  writeFileSync(path.join(dir, "Cargo.toml"), '[package]\nname = "sample"\nversion = "0.1.0"\nedition = "2021"\n');
  const parse = kind === "failing"
    ? "text.trim_start_matches('-').parse().unwrap_or(0)"
    : "text.parse().unwrap_or(0)";
  const slow = SLOW_TESTS.map(([name, input, expected]) =>
    `    #[test]\n    fn ${name}() {\n        slow_setup();\n        assert_eq!(parse("${input}"), ${expected});\n    }\n`).join("\n");
  writeFileSync(path.join(dir, "src", "lib.rs"), `pub fn parse(text: &str) -> i64 {
    ${parse}
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;
    use std::thread;
    use std::time::Duration;

    static SERIAL: Mutex<()> = Mutex::new(());

    fn slow_setup() {
        let _guard = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
        thread::sleep(Duration::from_secs(8));
    }

    #[test]
    fn ${FAILING_TEST}() {
        assert_eq!(parse("-4"), -4);
    }

${slow}}
`);
  return dir;
}

/** 에이전트 세션 하나를 돌리고, 이벤트마다 시작부터 지난 시간을 붙여 모은다. */
function runAgent(dir, arm) {
  const mcpConfig = path.join(dir, ".mcp-experiment.json");
  writeFileSync(mcpConfig, JSON.stringify({ mcpServers: { shell: {
    command: process.execPath, args: [SERVER], env: { LONGTASK_ARM: arm, LONGTASK_WORKDIR: dir },
  } } }));
  const tools = arm === "task" ? ["mcp__shell__run", "mcp__shell__task"] : ["mcp__shell__run"];
  return new Promise(resolve => {
    const started = Date.now();
    const child = spawn("claude", [
      "-p", QUESTION,
      "--model", MODEL,
      "--system-prompt", SYSTEM_PROMPT,
      "--setting-sources", "",
      "--strict-mcp-config", "--mcp-config", mcpConfig,
      "--tools", "",
      "--allowedTools", ...tools,
      "--no-session-persistence",
      "--output-format", "stream-json", "--verbose",
    ], { cwd: dir, stdio: ["ignore", "pipe", "pipe"] });
    const events = [];
    let   pending = "";
    child.stdout.on("data", chunk => {
      pending += chunk;
      const lines = pending.split("\n");
      pending = lines.pop() ?? "";
      for (const line of lines) {
        try { events.push({ at: Date.now() - started, event: JSON.parse(line) }); } catch { /* JSON이 아닌 줄 */ }
      }
    });
    const timer = setTimeout(() => child.kill("SIGKILL"), 900_000);
    child.on("close", () => {
      clearTimeout(timer);
      resolve({ events, total_ms: Date.now() - started });
    });
  });
}

function summarize({ events, total_ms }, kind) {
  let calls = 0;
  let cancelled = false;
  let knewFailureAt;
  let answer = "";
  let finished = false;
  for (const { at, event } of events) {
    if (event.type === "result") {
      answer   = typeof event.result === "string" ? event.result : "";
      finished = event.subtype === "success";
    }
    const content = event.message?.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (event.type === "assistant" && block.type === "tool_use") {
        calls++;
        if (block.input?.action === "cancel") cancelled = true;
      }
      if (event.type === "user" && block.type === "tool_result" && knewFailureAt === undefined) {
        const text = Array.isArray(block.content) ? block.content.map(c => c.text ?? "").join("") : String(block.content ?? "");
        if (text.includes(FAILING_TEST)) knewFailureAt = at;
      }
    }
  }
  const namesFailure = answer.includes(FAILING_TEST);
  const namesOther   = SLOW_TESTS.some(([name]) => new RegExp(`${name}\\W[^.\\n]*fail`, "i").test(answer));
  const success = kind === "failing"
    ? namesFailure && !namesOther
    : /all (?:\d+ )?tests? pass|no tests? fail|none fail|0 failed|no failures/i.test(answer);
  return {
    success, finished, calls, cancelled,
    total_s: Math.round(total_ms / 100) / 10,
    ...(knewFailureAt !== undefined && { knew_failure_s: Math.round(knewFailureAt / 100) / 10 }),
    answer: answer.slice(0, 300),
  };
}

async function runTrial(trial) {
  const dir = createCrate(trial.kind);
  try {
    return { ...trial, ...summarize(await runAgent(dir, trial.arm), trial.kind) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function pool(items, size, worker) {
  const results = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: size }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await worker(items[index]);
      process.stderr.write(".");
    }
  }));
  process.stderr.write("\n");
  return results;
}

const trials = [];
for (const kind of KINDS) for (let repeat = 0; repeat < REPEATS; repeat++) for (const arm of ARMS) trials.push({ kind, arm, repeat });
const results = await pool(trials, PARALLEL, runTrial);

const median = values => {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid    = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) * 5) / 10;
};
const cell = rows => ({
  n:                     rows.length,
  success:               rows.filter(r => r.success).length,
  median_total_s:        median(rows.map(r => r.total_s)),
  median_knew_failure_s: median(rows.filter(r => r.knew_failure_s !== undefined).map(r => r.knew_failure_s)),
  median_calls:          median(rows.map(r => r.calls)),
  cancelled:             rows.filter(r => r.cancelled).length,
});
const summary = Object.fromEntries(KINDS.map(kind => [kind, Object.fromEntries(ARMS.map(arm =>
  [arm, cell(results.filter(r => r.kind === kind && r.arm === arm))]))]));

console.log(`model=${MODEL} repeats=${REPEATS}`);
for (const kind of KINDS) {
  console.log(`\n${kind}`);
  for (const arm of ARMS) {
    const c = summary[kind][arm];
    console.log(`  ${arm.padEnd(10)} 성공 ${c.success}/${c.n}  세션 ${c.median_total_s}초  ` +
      `${kind === "failing" ? `실패를 안 시각 ${c.median_knew_failure_s ?? "-"}초  ` : ""}호출 ${c.median_calls}회  취소 ${c.cancelled}건`);
  }
}

const outFile = path.join(HERE, "long-task", `results-${MODEL.replace(/[^a-z0-9.-]/gi, "_")}.json`);
writeFileSync(outFile, `${JSON.stringify({ model: MODEL, repeats: REPEATS, summary, trials: results }, null, 2)}\n`);
console.log(`\n결과 파일: ${path.relative(process.cwd(), outFile)}`);
