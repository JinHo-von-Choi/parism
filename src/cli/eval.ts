/**
 * `parism eval` — 계획서 4.5장 "결과 판정을 execution/parse/task 로 분리한다".
 *
 * ## 왜 하나짜리 성공률로 부족했나
 *
 * 예전 판정은 `result.ok` **한 개**였다. 그래서 서로 아무 관계없는 세 가지가 한 비율에 섞였다.
 *
 *   - **이 호스트에 명령이 있는가** (`docker ps` 가 이 기회에 설치돼 있나)
 *   - **parism 에 그 명령의 파서가 있는가**
 *   - **명령이 기대대로 끝났나**
 *
 * 실측으로 드러난 예: `node --version` 이 실패로 집계됐다. 실제로는 **가드가 정상적으로 막은 것**이었다
 * (`command_not_allowed`). 명령이 안 돌았고 파싱도 없었고 과제도 없었는데,
 * 보고서는 그것을 "완료율 85.7%" 의 실패 1건으로 적었다. **parism 의 실패가 아니라 정책이 일한 것**을
 * 실패로 센 셈이다.
 *
 * 또 시나리오가 호스트를 재고 있었다. `retry-rate` 라 이름 붙은 시나리오가
 * `curl -I http://localhost:9999` · `docker ps` · `kubectl get pods` 를 돌려
 * "재시도율" 을 재 purportedly 했다 — **재시도를 한 번도 세지 않았다.**
 *
 * ## 판정을 세 개로 나눈다
 *
 *   execution  명령이 **실제로 실행되었는가.** 가드가 막은 것과 실행 자체가 실패한 것을 구분한다.
 *   parse      실행된 명령을 parism 가 구조로 읽었는가. **파서가 없는 것은 실패가 아니다.**
 *   task       그 명령이 자기 과제를 해냈는가. 없는 걸 찾는 과제는 실패해야 성공이다.
 *
 * 각각 따로 집계한다. 하나를 들추면 나머지가 흐려지지 않는다.
 *
 * ## 기대값을 정하지 않은 항목은 비율에 넣지 않는다
 *
 * 기대가 없으면 일치 여부는 알 수 없다. 모르는 것을 안다고 적지 않는다 —
 * 아는 척 숫자를 채우는 것이 이 프로젝트가 가장 경계하는 실패다.
 * 호스트에 따라 달라지는 항목은 기대를 두지 않고 사실만 남긴다.
 *
 * 작성자: 최진호
 * 작성일: 2026-10-05
 */

import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir }            from "node:os";
import { join }              from "node:path";
import { createEngine }      from "../facade/engine.js";

type EngineType = Awaited<ReturnType<typeof createEngine>>;

export interface Expectation {
  execution?: "ran" | "blocked" | "spawn_failed";
  parse?:     "parsed" | "unparsed" | "parse_error";
  /** `succeed` — 기대한 대로 성공해야. `fail` — 없는 것을 찾는 과제라 실패해야 성공이다. */
  task?:      "succeed" | "fail";
  /** 이 호스트에 따라 결과가 달라진다. 비율에 넣지 않고 관측값만 남긴다. */
  environmentDependent?: boolean;
}

export interface EvalCase {
  id:   string;
  cmd:  string;
  /** 의사 명령(`@…`)은 argv 대신 계약 하나를 관측한다. 그때는 비어 있다. */
  args?: string[];
  expect?: Expectation;
  note?:   string;
}

/** 관측 — 세 판단을 **따로** 본다. 하나가 null 이 나머지를 지우지 않는다. */
export interface EvalCaseResult {
  id:     string;
  cmd:    string;
  args:   string[];
  /** 가드가 막은 것은 `blocked` 다. parism 의 실패와 다른 결과다. */
  execution: "ran" | "blocked" | "spawn_failed";
  /** 실행되지 않았으면 `null` — "실패" 가 아니라 "볼 수 없었다" 다. */
  parse: "parsed" | "unparsed" | "parse_error" | null;
  task:  "succeeded" | "failed" | null;
  /** 이 항목에 세운 기대. 없으면 판정하지 않는다 — 관측만 남긴다. */
  expect?: Expectation;
  /** 기대와 어긋난 항목들. 비었으면 기대한 대로였거나(또는 기대가 없었다). */
  mismatches: string[];
  note?:  string;
}

export interface LevelStats {
  /** 이 판단에 기대가 있어서 판정한 항목 수. */
  judged:   number;
  matched:  number;
  /** 관측값 분포. 기대와 무관하게 센다. */
  observed: Record<string, number>;
}

export interface EvalScenarioReport {
  cases:     EvalCaseResult[];
  execution: LevelStats;
  parse:     LevelStats;
  task:      LevelStats;
}

export interface EvalReport {
  scenarios: Record<string, EvalScenarioReport>;
}

type Level = keyof Pick<Expectation, "execution" | "parse" | "task">;

const LEVELS: readonly Level[] = ["execution", "parse", "task"];

/** 기대값 표기를 관측값 표기로 맞춘다 (`succeed` → `succeeded`). */
function normalize(level: Level, want: string): string {
  if (level !== "task") return want;
  return want === "succeed" ? "succeeded" : "failed";
}

/** 한 판단의 집계. 기대가 있는 항목만 '판정' 에 넣는다. */
function statsFor(results: EvalCaseResult[], level: Level): LevelStats {
  const out: LevelStats = { judged: 0, matched: 0, observed: {} };
  for (const r of results) {
    const got = r[level];
    if (got !== null) out.observed[got] = (out.observed[got] ?? 0) + 1;
    const want = r.expect?.[level];
    if (want === undefined || r.expect?.environmentDependent === true) continue;
    out.judged++;
    if (got !== null && normalize(level, want) === got) out.matched++;
  }
  return out;
}

function buildReport(results: EvalCaseResult[]): EvalScenarioReport {
  return {
    cases:     results,
    execution: statsFor(results, "execution"),
    parse:     statsFor(results, "parse"),
    task:      statsFor(results, "task"),
  };
}

/**
 * 명령 하나를 돌려 세 판단을 각각 관측한다.
 *
 * **가드가 막은 것을 '실행 실패'로 두지 않는다.** 그건 정책이 일한 것이다.
 * 특히 `allowed_commands` 에 없는 명령은 이 환경에서 정상적으로 막힌다.
 */
async function observe(engine: EngineType, c: EvalCase): Promise<EvalCaseResult> {
  const base = { id: c.id, cmd: c.cmd, args: c.args ?? [] };

  let result: Awaited<ReturnType<EngineType["run"]>>;
  try {
    result = await engine.run(c.cmd, { args: c.args });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      ...base,
      execution: "spawn_failed", parse: null, task: null,
      mismatches: [`execution: 예외로 끝났다 — ${message}`],
      ...(c.note ? { note: c.note } : {}),
    };
  }

  if (result.guard_error) {
    return {
      ...base,
      execution: "blocked", parse: null, task: null,
      mismatches: [],
      note: `가드 거절 (${result.guard_error.reason}) — 정책이 일한 것이다`,
    };
  }

  /**
   * 세 가지를 구분한다 — **'파서가 없다'는 실패가 아니다.**
   *   parsed       구조로 읽었다
   *   parse_error  파서가 있는데 이 입력에 대해 실패했다 (명시적 실패)
   *   unparsed     파서가 없다 / 지원하지 않는 형식 — 정상적인 상태다
   */
  const parse: EvalCaseResult["parse"] =
    result.stdout.parsed != null ? "parsed"
    : result.failure?.kind === "parse" || result.stdout.parse_error ? "parse_error"
    : "unparsed";

  return {
    ...base,
    execution: "ran", parse, task: result.ok ? "succeeded" : "failed",
    mismatches: [],
    ...(c.note ? { note: c.note } : {}),
  };
}

/** 관측과 기대를 대조한다. 기대가 있는 판단만, 그리고 그 판단만 본다. */
function compare(c: EvalCaseResult, want?: Expectation): string[] {
  const bad: string[] = [];
  if (!want) return bad;
  if (want.environmentDependent === true) return bad;

  for (const level of LEVELS) {
    const expected = want[level];
    if (expected === undefined) continue;
    const got = c[level];
    if (got === null) {
      bad.push(`${level}: 실행되지 않아 '${expected}' 을 관측할 수 없었다`);
      continue;
    }
    if (normalize(level, expected) !== got) {
      bad.push(`${level}: '${got}' — 기대 '${expected}' 와 다르다`);
    }
  }
  return bad;
}

// ── 시나리오 ───────────────────────────────────────────────────────────────

/**
 * 실행과 파싱이 **따로** 성공해야 하는지 본다.
 *
 * 예전 판정은 `result.ok` 하나라, 파서가 없는 명령이 '실패' 로 모였다.
 * parism 이 파서를 갖고 있지 않다는 것은 **파서가 없다는 사실**이지 실패가 아니다.
 * 그래서 여기서는 실행만 기대하고, 파싱은 **관측만** 한다(아래에서 기대를 둔 항목은 따로).
 */
const EXECUTION_AND_PARSE: EvalCase[] = [
  { id: "ls-here",        cmd: "ls",  args: ["-la", "."],        expect: { execution: "ran" } },
  { id: "du-here",        cmd: "du",  args: ["-sh", "."],        expect: { execution: "ran" } },
  { id: "stat-here",      cmd: "stat", args: ["."],               expect: { execution: "ran" } },
  { id: "ps-aux",         cmd: "ps",  args: ["aux"],               expect: { execution: "ran", parse: "parsed" } },
  { id: "git-porcelain", cmd: "git", args: ["status", "--porcelain"], expect: { execution: "ran" } },
  { id: "df",             cmd: "df",  args: ["-h"],                expect: { execution: "ran" } },
  { id: "pwd",            cmd: "pwd", args: [],                    expect: { execution: "ran", task: "succeed" } },
  /** 없는 경로를 찾는 과제 — 실패해야 성공이다. `-l` 을 준다: 없으면 형식부터 걸린다(아래 항목). */
  { id: "ls-missing",     cmd: "ls",  args: ["-l", "parism-eval-없는-파일"],
    expect: { execution: "ran", parse: "parsed", task: "fail" } },
  /**
   * **지원하지 않는 형식은 실패로 드러나야 한다** (계획서 4장).
   * `ls` 에 `-l` 이 없으면 파서는 긴 목록만 읽는다. 빈 결과를 조용히 내는 것이 아니라
   * `unsupported_format` 로 말해야 하며, 함께 대체 인자를 제시한다.
   * 처음에는 이 판단과 "없는 파일" 과제를 한 항목에 섞어 두 실패를 한 것처럼 보였다.
   */
  { id: "unsupported-fmt", cmd: "ls", args: ["parism-eval-없는-파일"],
    expect: { execution: "ran", parse: "parse_error" },
    note: "지원하지 않는 형식은 조용한 빈 결과가 아니라 명시적 실패여야 한다" },
  /** 파서가 없는 명령. 실행은 되지만 구조로 읽히지 않는다 — 그게 정상이다 */
  { id: "no-parser",      cmd: "uname", args: ["-a"],              expect: { execution: "ran" } },
  /**
   * **경로 가드.** 실행 디렉터리 밖의 경로는 막힌다 — 기본 `allowed_paths` 가 cwd 하나다.
   * 막힌 것은 실패가 아니라 정책이 일한 것이다. 실측: `ls -la /tmp` → `path_not_allowed`.
   * 처음에는 이 항목을 '실행 실패' 로 세고 parism 이 명령을 못 실행한다고 보고했다.
   * 실제로는 **명령은 목록에 있고 경로가 막힌 것**이었다. 둘을 구분하지 않으면 어느 쪽인지 알 수 없다.
   */
  { id: "path-guard",     cmd: "ls",  args: ["-la", "/tmp"],
    expect: { execution: "blocked" }, note: "허용 경로 밖 — 막히면 정상이다" },
  /** 명령 가드. 허용 목록에 없는 명령은 막힌다 */
  { id: "command-guard",  cmd: "node", args: ["--version"],
    expect: { execution: "blocked" }, note: "허용 명령 목록에 없음 — 막히면 정상이다" },
  /** 이 호스트에 없을 수 있다. 기대를 두지 않고 관측만 남긴다 — 아는 척 하지 않는다 */
  { id: "docker-ps",      cmd: "docker", args: ["ps"],              expect: { environmentDependent: true } },
];

const RETRY_AND_REFUSAL: EvalCase[] = [
  { id: "no-re-execution",  cmd: "@no-re-execution", expect: { task: "succeed" },
    note: "보관한 결과를 explain_result 로 다시 봤을 때 **원래 값**이 오는가 (다르면 재실행이다)" },
  { id: "unknown-id",      cmd: "@unknown-id",       expect: { task: "succeed" },
    note: "모르는 id 는 사유를 함께 거절한다 — 조용히 새로 실행하지 않는다" },
];

export const SCENARIOS: Record<string, EvalCase[]> = {
  "execution-parse": EXECUTION_AND_PARSE,
  "retry-rate":     RETRY_AND_REFUSAL,
};

export const SCENARIO_NAMES: readonly string[] = Object.keys(SCENARIOS);

/**
 * 재실행 금지 계약을 직접 관측한다.
 *
 * 계약은 하나다 — **저장한 결과는 다시 실행하지 않는다.**
 *
 * 관측하려면 "다시 돌렸다면 값이 달라지는" 상황을 만들어야 한다.
 * 그래서 **빈 임시 저장소**에서 `git status --porcelain` 을 보관하고,
 * 그 뒤에 **새 파일을 하나 만든다.**
 *
 *   - 보관본이 **스냅샷**이면 → 새 파일이 보이지 않는다. 재실행하지 않았다.
 *   - 재실행했다면        → 새 파일이 보인다. 계약 위반이다.
 *
 * 시간을 두는 방법보다 확실하다. 시각은 1초 안에 같을 수 있지만
 * 만든 파일은 열거에 남는다. **관측이 추정에 의존하지 않게** 하는 것이 여기서 중요하다.
 *
 * 임시 디렉터리는 평가가 만든 것이니 평가가 지운다.
 */
async function observeNoReExecution(c: EvalCase): Promise<EvalCaseResult> {
  const base = { id: c.id, cmd: c.cmd, args: c.args ?? [] };
  const bad: string[] = [];
  const MARKER = "parism-eval-재실행-표시.txt";

  const dir = await mkdtemp(join(tmpdir(), "parism-eval-"));
  try {
    const git = (args: string[]) =>
      execFileSync("git", args, { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

    git(["init", "-q", "."]);
    /** 보관 시점에 이 파일 하나만 보인다 */
    execFileSync("touch", [join(dir, "처음부터-있던.txt")]);

    /**
     * **임시 저장소 경로를 쓰려면 그 경로를 허용해야 한다.**
     * 가드의 기본 `allowed_paths` 는 실행 디렉터리(process.cwd()) 하나다.
     * 엔진은 실행 디렉터리를 인자로 받지 않고 설정 파일로 받으므로, 그 경로가 든 설정을 넘긴다.
     * 이 사실을 몰랐으면 평가는 "계약 위반" 이 아니라 "가드에 막힘" 을 계약 위반으로 보고했을 것이다.
     */
    const configPath = join(dir, "parism-eval.config.json");
    await writeFile(configPath, JSON.stringify({ guard: { allowed_paths: [dir] } }, null, 2));
    const scoped = await createEngine({ configPath });

    const first = await scoped.run("git", {
      args: ["status", "--porcelain", "-z"],
      cwd: dir,
      contract_version: "next", evidence: "fields", retain: true,
    });
    const resultId = first.review?.result_id;

    if (first.guard_error) {
      return { ...base, execution: "blocked", parse: null, task: null, mismatches: [], note: "가드 거절 — 관측 불가" };
    }
    if (!resultId || first.review?.retained !== true) {
      return {
        ...base, execution: "ran", parse: null, task: "failed",
        mismatches: [`task: 결과를 보관하지 못했다 (retained=${String(first.review?.retained)}) — 계약을 관측할 수 없다`],
        ...(c.note ? { note: c.note } : {}),
      };
    }

    /** 보관한 뒤, 다시 실행했다면 반드시 드러나게 만든다 */
    execFileSync("touch", [join(dir, MARKER)]);

    const firstRead  = scoped.explainResult(resultId, "/entries/0/path");
    const secondRead = scoped.explainResult(resultId, "/entries/0/path");

    if (!firstRead.ok) {
      bad.push(`task: explain 이 거절했다 (${firstRead.reason})`);
    } else {
      /**
       * 새 파일이 보이면 재실행한 것이다.
       * 항목 수로 보지 않고 **값**으로 본다 — 값이 원문과 같아야 진짜 보관본이다.
       */
      if (firstRead.value === MARKER) {
        bad.push(`task: 보관한 결과에 나중에 만든 파일 '${MARKER}' 가 보인다 — 재실행했다`);
      }
      const storedPath = (first.stdout.parsed as { entries?: Array<{ path?: unknown }> } | null)
        ?.entries?.[0]?.path;
      if (firstRead.value !== storedPath) {
        bad.push(`task: explain 이 돌려준 값(${JSON.stringify(firstRead.value)}) 이 보관 시점의 값(${JSON.stringify(storedPath)}) 과 다르다`);
      }
    }
    if (secondRead.ok && firstRead.ok && secondRead.value !== firstRead.value) {
      bad.push("task: 두 번 읽은 값이 다르다 — 보관본이 아니다");
    }

    /** 모르는 id 는 사유를 함께 거절해야 한다 — 조용히 새로 실행하지 않는다 */
    const bogus = scoped.explainResult("parism-eval-존재하지-않는-id", "/entries/0/path");
    if (bogus.ok) bad.push("task: 모르는 id 를 거절하지 않고 값을 돌려준다");

    return {
      ...base,
      execution: "ran",
      parse:     first.stdout.parsed != null ? "parsed" : "unparsed",
      task:      bad.length === 0 ? "succeeded" : "failed",
      mismatches: bad,
      ...(c.note ? { note: c.note } : {}),
    };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * 시나리오를 돌린다.
 *
 * @param names 실행할 시나리오 이름. 없거나 비면 전부.
 */
export async function runEvalSuite(names?: readonly string[]): Promise<EvalReport> {
  const engine = await createEngine();
  const chosen = names && names.length > 0 ? names : SCENARIO_NAMES;
  const scenarios: Record<string, EvalScenarioReport> = {};

  for (const name of chosen) {
    const cases = SCENARIOS[name];
    if (!cases) continue;

    const results: EvalCaseResult[] = [];
    for (const c of cases) {
      let observed: EvalCaseResult;
      if (c.cmd === "@no-re-execution")      observed = await observeNoReExecution(c);
      else if (c.cmd === "@unknown-id")      observed = await observeUnknownId(engine, c);
      else                                   observed = await observe(engine, c);
      /**
       * 기대 대조는 마지막에 한 번만 한다 — 관측과 판정을 한 곳에 모은다.
       *
       * **관측자가 스스로 적은 사유를 지우지 않는다.** 비교 결과로 덮어쓰면
       * "무엇이 왜 어긋났는지" 를 아는 사람이 사라지고 'failed — 기대와 다름' 만 남는다.
       * 그 한 줄로는 무엇을 고칠지 알 수 없다.
       */
      const mismatches = [...observed.mismatches, ...compare(observed, c.expect)];
      results.push({ ...observed, expect: c.expect, mismatches });
    }
    scenarios[name] = buildReport(results);
  }
  return { scenarios };
}

/** 모르는 id 를 거절하는지 본다. 조용히 새로 실행하면 안 된다. */
async function observeUnknownId(engine: EngineType, c: EvalCase): Promise<EvalCaseResult> {
  const base = { id: c.id, cmd: c.cmd, args: c.args ?? [] };
  const bogus = engine.explainResult("parism-eval-존재하지-않는-id", "/stdout/raw");

  if (bogus.ok) {
    return {
      ...base, execution: "ran", parse: "unparsed", task: "failed",
      mismatches: ["task: 모르는 id 를 거절하지 않고 값을 돌려준다"],
      ...(c.note ? { note: c.note } : {}),
    };
  }
  return {
    ...base, execution: "ran", parse: "unparsed", task: "succeeded", mismatches: [],
    note: `거절 사유: ${bogus.reason}${c.note ? ` — ${c.note}` : ""}`,
  };
}
