#!/usr/bin/env node
/**
 * Terminal-Bench 2.0 실험 -- 셸 대신 Parism만 가진 에이전트가 터미널 과제를 얼마나 푸는가.
 *
 * Harbor로 Terminal-Bench 2.0 과제를 도커 컨테이너에서 돌린다. 에이전트는 Claude Code이고 두 조건은 명령 실행 도구만 다르다.
 *
 *   shell  -- Bash 도구로 명령을 실행한다
 *   parism -- Bash 도구가 없다. Parism MCP 서버의 run, task 도구로 명령을 실행한다
 *
 * parism 조건의 서버는 build 프로필이고, 허용 명령을 빌드·시험·파일 작업 도구까지 넓히고
 * (experiments/terminal-bench/prism.config.json) 작업 공간 안의 실행 파일을 경로로 실행하게 한다.
 * 빌드한 dist와 node 실행 파일을 컨테이너에 읽기 전용으로 마운트한다.
 *
 * 재는 값:
 *   통과 -- 과제의 검증 스크립트가 준 점수(1이면 통과)
 *   도구 호출 수, Parism 호출이 실행됐는지 가드에 막혔는지와 막힌 사유
 *
 * 사용:
 *   npm run build
 *   node experiments/terminal-bench.mjs run shell
 *   node experiments/terminal-bench.mjs run parism
 *   node experiments/terminal-bench.mjs tally <shell|parism> <Harbor 작업 폴더>...
 *
 * 환경 변수:
 *   CLAUDE_CODE_OAUTH_TOKEN  컨테이너 안 에이전트의 인증 토큰 (`claude setup-token`). run에 필요하다
 *   PARISM_TB_MODEL          에이전트 모델 (기본 haiku)
 *   PARISM_TB_TASKS          쉼표로 나눈 과제 이름 (기본 TASKS)
 *   PARISM_TB_PARALLEL       동시에 돌리는 과제 수 (기본 8)
 *   PARISM_TB_JOBS           Harbor 작업 폴더를 둘 위치 (기본 임시 폴더)
 *
 * uvx(harbor 실행)와 도커가 있어야 한다.
 *
 * 작성자: 최진호
 * 작성일: 2026-11-12
 */

import { spawnSync } from "node:child_process";
import {
  chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const HERE     = import.meta.dirname;
const REPO     = path.resolve(HERE, "..");
const ASSETS   = path.join(HERE, "terminal-bench");
const MODEL    = process.env.PARISM_TB_MODEL ?? "haiku";
const PARALLEL = process.env.PARISM_TB_PARALLEL ?? "8";
const ARMS     = ["shell", "parism"];
const TASKS    = (process.env.PARISM_TB_TASKS ?? [
  "fix-git", "git-leak-recovery", "sanitize-git-repo", "git-multibranch", "configure-git-webserver",
  "build-pmars", "build-cython-ext", "sqlite-with-gcov", "log-summary-date-ranges", "regex-log",
  "openssl-selfsigned-cert", "nginx-request-logging", "pypi-server", "kv-store-grpc", "fix-code-vulnerability",
  "cobol-modernization", "polyglot-c-py", "modernize-scientific-stack", "prove-plus-comm", "multi-source-data-merger",
].join(",")).split(",").map(name => name.trim()).filter(Boolean);

const RESULTS_FILE = path.join(ASSETS, `results-${MODEL.replace(/[^a-z0-9.-]/gi, "_")}.json`);

/** 컨테이너에 마운트할 Parism 사본을 만든다: dist, 실행 의존성, 설정, 시작 스크립트, node 실행 파일. */
function stageParism(root) {
  const parism = path.join(root, "parism");
  const node   = path.join(root, "node", "bin");
  mkdirSync(parism, { recursive: true });
  mkdirSync(node, { recursive: true });
  cpSync(path.join(REPO, "dist"), path.join(parism, "dist"), { recursive: true });
  for (const file of ["package.json", "package-lock.json"]) copyFileSync(path.join(REPO, file), path.join(parism, file));
  const install = spawnSync("npm", ["install", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"], { cwd: parism, stdio: "inherit" });
  if (install.status !== 0) throw new Error("npm install failed");
  copyFileSync(path.join(ASSETS, "prism.config.json"), path.join(parism, "prism.config.json"));
  copyFileSync(path.join(ASSETS, "start.sh"), path.join(parism, "start.sh"));
  chmodSync(path.join(parism, "start.sh"), 0o755);
  copyFileSync(process.execPath, path.join(node, "node"));
  return [
    { type: "bind", source: parism, target: "/opt/parism", read_only: true },
    { type: "bind", source: path.join(root, "node"), target: "/opt/parism-node", read_only: true },
  ];
}

function run(arm) {
  if (!process.env.CLAUDE_CODE_OAUTH_TOKEN) throw new Error("CLAUDE_CODE_OAUTH_TOKEN is not set");
  const root = process.env.PARISM_TB_JOBS ?? mkdtempSync(path.join(tmpdir(), "parism-tb-"));
  const jobs = path.join(root, "jobs");
  const job  = `${arm}-${Date.now()}`;
  const args = [
    "harbor", "run", "-d", "terminal-bench@2.0", "-a", "claude-code", "-m", MODEL,
    "-o", jobs, "--job-name", job, "-y", "-q", "-n", PARALLEL, "--agent-setup-timeout-multiplier", "4", "-r", "3",
    ...TASKS.flatMap(name => ["-i", name]),
  ];
  if (arm === "parism") {
    args.push(
      "--mcp-config", path.join(ASSETS, "mcp.json"),
      "--mounts", JSON.stringify(stageParism(root)),
      "--ak", `append_system_prompt=${readFileSync(path.join(ASSETS, "prompt.txt"), "utf8").trim()}`,
      "--ak", "disallowed_tools=Bash",
    );
  }
  const env = { ...process.env, CLAUDE_FORCE_OAUTH: "1" };
  delete env.ANTHROPIC_API_KEY;
  delete env.ANTHROPIC_AUTH_TOKEN;
  spawnSync("uvx", args, { stdio: "inherit", env });
  return path.join(jobs, job);
}

/** 도구 결과 본문에서 Parism 응답 JSON을 꺼낸다. 응답은 `[cwd] 경로` 줄 다음에 온다. */
function parismResult(content) {
  const text  = Array.isArray(content) ? content.map(part => part.text ?? "").join("") : String(content ?? "");
  const start = text.indexOf("{");
  if (start < 0) return undefined;
  try { return JSON.parse(text.slice(start)); } catch { return undefined; }
}

/** 과제 하나의 세션 기록에서 도구 호출 수와 Parism 호출 결과를 센다. */
function readSession(file) {
  const tools   = {};
  const parism  = {};
  const pending = new Set();
  let   seconds;
  if (!existsSync(file)) return { tools, parism };
  for (const line of readFileSync(file, "utf8").split("\n")) {
    let event;
    try { event = JSON.parse(line); } catch { continue; }
    if (event.type === "result") seconds = Math.round((event.duration_ms ?? 0) / 1000);
    const content = event.message?.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (event.type === "assistant" && block.type === "tool_use") {
        const name = block.name.replace("mcp__parism__", "parism:");
        tools[name] = (tools[name] ?? 0) + 1;
        if (block.name === "mcp__parism__run") pending.add(block.id);
      }
      if (event.type === "user" && block.type === "tool_result" && pending.has(block.tool_use_id)) {
        const result  = parismResult(block.content);
        const outcome = !result ? "invalid_input"
          : result.ok ? "ran"
          : result.failure ? `${result.failure.kind}/${result.failure.reason}`
          : result.task ? "task_started" : "other";
        parism[outcome] = (parism[outcome] ?? 0) + 1;
      }
    }
  }
  return { tools, parism, ...(seconds !== undefined && { seconds }) };
}

/** 작업 폴더가 여럿이면 과제마다 점수가 있는 첫 시도를 쓴다. 설치 오류로 점수가 없는 과제를 다시 돌린 경우다. */
function tally(arm, jobDirs) {
  const byTask = new Map();
  for (const jobDir of jobDirs) for (const entry of readdirSync(jobDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir        = path.join(jobDir, entry.name);
    const resultFile = path.join(dir, "result.json");
    const result     = existsSync(resultFile) ? JSON.parse(readFileSync(resultFile, "utf8")) : {};
    const reward     = result.verifier_result?.rewards?.reward;
    const exception  = result.exception_info?.exception_type;
    const task       = entry.name.split("__")[0];
    if (byTask.get(task)?.reward !== undefined) continue;
    byTask.set(task, {
      task,
      ...(reward !== undefined && { reward }),
      ...(exception && { exception }),
      ...readSession(path.join(dir, "agent", "claude-code.txt")),
    });
  }
  const trials = [...byTask.values()].sort((a, b) => a.task.localeCompare(b.task));
  const scored = trials.filter(trial => trial.reward !== undefined);
  const parism = {};
  for (const trial of trials) for (const [key, count] of Object.entries(trial.parism)) parism[key] = (parism[key] ?? 0) + count;
  const summary = { tasks: trials.length, scored: scored.length, passed: scored.filter(trial => trial.reward === 1).length, parism_calls: parism };

  let all = { model: MODEL, arms: {} };
  try { all = JSON.parse(readFileSync(RESULTS_FILE, "utf8")); } catch { /* 결과 파일이 아직 없다 */ }
  all.arms[arm] = { summary, trials };
  writeFileSync(RESULTS_FILE, `${JSON.stringify(all, null, 2)}\n`);

  console.log(`${arm}: 통과 ${summary.passed}/${summary.scored} (과제 ${summary.tasks}개)`);
  for (const trial of trials) {
    const state = trial.reward === undefined ? `점수 없음(${trial.exception ?? "?"})` : trial.reward === 1 ? "통과" : "실패";
    console.log(`  ${trial.task.padEnd(28)} ${state.padEnd(6)} ${JSON.stringify(trial.tools)}`);
  }
  if (Object.keys(parism).length > 0) console.log(`  Parism 호출: ${JSON.stringify(parism)}`);
  console.log(`결과 파일: ${path.relative(process.cwd(), RESULTS_FILE)}`);
}

const [action, arm, ...jobDirs] = process.argv.slice(2);
if (!ARMS.includes(arm) || (action !== "run" && !(action === "tally" && jobDirs.length > 0))) {
  console.error("usage: terminal-bench.mjs run <shell|parism> | tally <shell|parism> <job dir>...");
  process.exit(2);
}
tally(arm, action === "run" ? [run(arm)] : jobDirs);
