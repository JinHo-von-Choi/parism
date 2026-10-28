#!/usr/bin/env node
/**
 * 1단계 행동 검증 — "명령이 없음" 실패를 다음 행동으로 바꾸면 에이전트의 다음 행동이 달라지는가.
 *
 * ## 무엇을 재는가
 *
 * parism 이 아직 없는 명령을 실행했을 때, 응답에 **설치 지시와 대체 명령**이 붙으면
 * 에이전트가 "같은 명령을 한 번 더 시도" 대신 "설치하거나 대체 명령으로 전환"을 선택하는가.
 * 이것이 1단계의 성공 기준이다. 점수가 아니라 **실패 모드가 사라지는가** 를 본다.
 *
 * Terminal-Bench 성적 자체는 재지 않는다. harness 개선의 효과 천계가 있다는 분석이 있기 때문이다.
 *
 * ## 측정 설계
 *
 * - **짝지 시험(paired)**: 같은 과제·같은 응답 틀에 **설치 정보만** 다르게 넣고 두 팔을 비교한다.
 *   명령·과제·프롬프트가 모두 같으니 비교 대상은 오직 그 한 가지다.
 * - **두 팔**:
 *   - `before` — 게시된 2.1.1 응답. `failure` 에 kind/reason/message 만 있다.
 *   - `after`  — 1단계 응답. `failure.availability` 에 설치 지시와 대체 명령이 있다.
 * - cwd 배너는 **양쪽 다** 넣는다. 배너까지 넣으면 비교 대상이 둘이 된다.
 * - 응답은 실제 엔진이 만든 것을 쓴다(메시지 문자열·구조가 실제와 같아야 한다).
 *
 * ## 쓰기
 *
 *   npm run build
 *   node experiments/environment-awareness-behavior.mjs
 *   node experiments/environment-awareness-behavior.mjs --out results.json
 *
 * 환경변수
 *   PARISM_BEHAVIOR_MODEL  사용할 모델 (기본 minimax/MiniMax-M3)
 *   LLM_CALL               llm_call.py 경로 (기본 ~/.minimax/.builtin-skills/llm-call/scripts/llm_call.py)
 *
 * 작성자: 최진호
 * 작성일: 2026-10-22
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir }             from "node:os";
import { join }                from "node:path";
import { ParismEngine }        from "../dist/facade/engine.js";
import { DEFAULT_CONFIG }      from "../dist/config/loader.js";
import { createRegistry }      from "../dist/parsers/index.js";
import { probeAll }            from "../dist/engine/availability.js";

const MODEL = process.env.PARISM_BEHAVIOR_MODEL ?? "minimax/MiniMax-M3";

/** 과제마다 세 가지 상황을 만든다. 한 명령당 표본이 너무 적으면 2pp 차이를 재지 못한다. */
const FRAMINGS = {
  helm: [
    "List the Helm releases deployed in the cluster",
    "Show which Helm releases are currently installed",
    "Check the Helm release revision history",
  ],
  kubectl: [
    "Show the pods running in the cluster",
    "List the containers and their status",
    "Check which workloads are unhealthy",
  ],
  terraform: [
    "Show the Terraform version in use",
    "Report the Terraform version of this environment",
    "Check which Terraform version is installed here",
  ],
  tree: [
    "Show the directory tree of this project",
    "Display the folder structure of the repository",
    "List the project directories as a tree",
  ],
  brew: [
    "List the Homebrew packages installed on this machine",
    "Show which Homebrew formulas are installed",
    "Report the installed Homebrew packages",
  ],
  pnpm: [
    "List the packages of the pnpm workspace",
    "Show what the pnpm workspace contains",
    "Report the pnpm workspace package list",
  ],
};

/** 각 명령에 실제로 쓸 인자. 가드를 통과해야 실행 단계까지 간다. */
const ARGS = {
  helm:      ["list"],
  kubectl:   ["get", "pods"],
  terraform: ["version"],
  tree:      ["-L", "2"],
  brew:      ["list"],
  pnpm:      ["list"],
};

const SYSTEM = [
  "You are an AI agent that runs shell commands through a tool called Parism.",
  "You are given one task and one tool response, and you must choose your single next action.",
  "Answer with exactly one letter and nothing else.",
  "Do not choose an option whose thing is not present in the response.",
].join(" ");

const OPTIONS = [
  "Which is your single next action?",
  "(A) Run the install command the response provides, to install the missing tool",
  "(B) Run a different command the response offers as doing the same job",
  "(C) Run the same command again with the same arguments",
  "(D) Stop and tell the user the tool is not available",
  "",
  "Reply with exactly one letter: A, B, C, or D.",
  "Do not choose an option whose thing is not present in the response.",
].join("\n");

/**
 * 모델에 한 질문만 던지고 답을 받는다.
 *
 * `mcode exec` 를 쓴다. 런타임이 가진 자격 증명을 그대로 쓰므로 별도 API 키가 필요 없다.
 * `--max-steps 1` 로 도구 호출을 막고, `--permission off` 로 실행 권한도 뺀다.
 * 매 시도마다 새 세션이라 앞선 시도의 맥락이 새지 않는다.
 */
function askModel(prompt, systemPromptPath) {
  const out = execFileSync(
    "mcode",
    [
      "exec",
      "--model", MODEL,
      "--permission", "off",
      "--max-steps", "1",
      "--output-format", "text",
      "--system-prompt-file", systemPromptPath,
      prompt,
    ],
    { encoding: "utf8", timeout: 300_000, stdio: ["ignore", "pipe", "pipe"], maxBuffer: 4 * 1024 * 1024 },
  );
  return out.trim();
}

/** 응답에서 선택지 글자를 뽑는다. */
function parseChoice(raw) {
  const m = raw.match(/\b([ABCD])\b/);
  return m ? m[1] : "?";
}

/** 게시된 2.1.1 모양으로 되돌린다. */
function toBefore(envelope) {
  const failure = envelope.failure;
  return {
    ...envelope,
    ...(failure && {
      failure: { kind: failure.kind, reason: failure.reason, message: failure.message },
    }),
  };
}

/** cwd 배너를 붙인다. 두 팔에 똑같이 붙인다. */
function withBanner(envelope) {
  return `[cwd] ${process.cwd()}\n\n${JSON.stringify(envelope, null, 2)}`;
}

async function main() {
  const outIndex = process.argv.indexOf("--out");
  const outPath  = outIndex === -1 ? null : process.argv[outIndex + 1];

  const config = structuredClone(DEFAULT_CONFIG);
  /**
   * build 프로필로 돌린다. `pnpm` 은 readonly 프로필에서 아예 막혀서 실행 단계에 닿지 못한다.
   * 프로필 차이는 ENOENT 응답에 영향을 주지 않는다(실행은 못 하는 것이 같으므로).
   */
  config.guard.profile      = "build";
  config.guard.allowed_paths = [process.cwd()];
  const engine = new ParismEngine(config, createRegistry());

  const statuses = probeAll(config.guard.allowed_commands);
  const missing  = [...statuses.entries()]
    .filter(([, r]) => r.status !== "installed")
    .map(([cmd]) => cmd)
    .filter(cmd => FRAMINGS[cmd]);

  if (missing.length === 0) {
    console.error("이 호스트에는 없는 허용 명령이 없다. 측정할 대상이 없다.");
    process.exit(1);
  }

  const trials = [];
  for (const cmd of missing) {
    for (const task of FRAMINGS[cmd]) {
      const args    = ARGS[cmd] ?? [];
      const result  = await engine.run(cmd, { args, cwd: process.cwd() });
      const before  = withBanner(toBefore(result));
      const after   = withBanner(result);
      trials.push({ id: `${cmd}:${task}`, cmd, task, args, before, after });
    }
  }

  console.error(` trials: ${trials.length} (명령 ${missing.length}종 × 상황 3)`);

  const records = [];
  const systemPath = join(mkdtempSync(join(tmpdir(), "parism-behavior-")), "system.txt");
  writeFileSync(systemPath, SYSTEM, "utf8");

  for (const trial of trials) {
    for (const arm of ["before", "after"]) {
      const prompt = [
        `Task: ${trial.task}`,
        "",
        "Tool response:",
        trial[arm],
        "",
        OPTIONS,
      ].join("\n");
      const raw    = askModel(prompt, systemPath);
      const choice = parseChoice(raw);
      records.push({ id: trial.id, cmd: trial.cmd, task: trial.task, arm, choice, raw: raw.slice(0, 120) });
      process.stderr.write(` ${arm.padEnd(6)} ${trial.cmd.padEnd(10)} ${choice}  ${raw.slice(0, 60).replace(/\n/g, " ")}\n`);
    }
  }

  /** 집계. `install_or_alternate` 가 1단계가 바꾼 행동이다. */
  const summary = {};
  for (const arm of ["before", "after"]) {
    const rows = records.filter(r => r.arm === arm);
    const count = letter => rows.filter(r => r.choice === letter).length;
    summary[arm] = {
      n:     rows.length,
      A:     count("A"),
      B:     count("B"),
      C:     count("C"),
      D:     count("D"),
      invalid: rows.filter(r => r.choice === "?").length,
      install_or_alternate_pct: rows.length === 0 ? 0
        : Number((((count("A") + count("B")) / rows.length) * 100).toFixed(1)),
      retry_pct:      rows.length === 0 ? 0 : Number(((count("C") / rows.length) * 100).toFixed(1)),
      stop_pct:       rows.length === 0 ? 0 : Number(((count("D") / rows.length) * 100).toFixed(1)),
    };
  }
  const delta = Number((summary.after.install_or_alternate_pct - summary.before.install_or_alternate_pct).toFixed(1));

  console.log("");
  console.log(" arm     n    A    B    C    D   ?   install|alternative   retry   stop");
  for (const arm of ["before", "after"]) {
    const s = summary[arm];
    console.log(
      ` ${arm.padEnd(7)} ${String(s.n).padStart(3)} ${String(s.A).padStart(4)} ${String(s.B).padStart(4)} ` +
      `${String(s.C).padStart(4)} ${String(s.D).padStart(4)} ${String(s.invalid).padStart(3)}   ` +
      `${String(s.install_or_alternate_pct).padStart(6)}%              ${String(s.retry_pct).padStart(5)}%  ${String(s.stop_pct).padStart(5)}%`,
    );
  }
  console.log("");
  console.log(` install|alternative 변화: ${delta >= 0 ? "+" : ""}${delta}pp`);

  const result = {
    model:   MODEL,
    trials:  trials.length,
    commands: missing,
    summary,
    delta_pp: delta,
    records,
  };
  if (outPath) {
    writeFileSync(outPath, JSON.stringify(result, null, 2));
    console.log(` 결과 저장: ${outPath}`);
  }
}

await main();
