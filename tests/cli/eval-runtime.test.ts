/**
 * `parism eval` 의 **실행 경로** 시험.
 *
 * `eval.test.ts` 가 시나리오의 *구조* 를 고정한다면 여기는 *관측* 을 고정한다.
 *
 * ## 왜 둘로 나눴나
 *
 * eval 의 존재 이유는 "실패" 라는 한 단어가 서로 다른 세 가지를 뭉개고 있었기 때문이다.
 *   - 가드가 막았다 (정책이 일한 것)
 *   - 실행 자체가 실패했다
 *   - 명령이 자기 과제를 해내지 못했다
 *
 * 이 셋을 구분하는 코드가 **한 번도 실행되지 않았다** — 파일 전체 커버리지가 17.78%,
 * 함수 커버리지가 0% 였다. 판정 로직이 조용히 사라져도 아무도 몰랐다.
 *
 * ## 판정하지 않는 것과 판정하는 것
 *
 * 내장 시나리오는 실제 명령을 돌리므로 **호스트마다 결과가 달라진다.**
 * 그래서 내장 시나리오는 **불변식**만 본다(관측값의 종류, 막히면 null 인 관계, 집계의 합).
 * "이 호스트에서 이 값이 나온다" 는 주장은 하지 않는다 — 주장이 틀리면
 * 그건 시험이 아니라 다른 호스트의 거짓말이 된다.
 *
 * 정확한 값은 **사용자 정의 시나리오**로 본다. 설정을 직접 주면
 * 허용 명령·허용 경로를 내가 정하므로 호스트와 무관하게 결과가 정해진다.
 *
 * 작성자: 최진호
 * 작성일: 2026-10-22
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, writeFile, rm }   from "node:fs/promises";
import { tmpdir }                    from "node:os";
import { join }                      from "node:path";

import {
  runEvalSuite,
  SCENARIOS,
  type EvalReport,
} from "../../src/cli/eval.js";

// ── 관측값이 가져야 할 값 ────────────────────────────────────────────────

const EXECUTIONS = ["ran", "blocked", "spawn_failed"] as const;
const PARSES     = ["parsed", "unparsed", "parse_error"] as const;
const TASKS      = ["succeeded", "failed"] as const;

// ── 내장 시나리오 ─────────────────────────────────────────────────────────

describe("eval 실행 — 내장 시나리오", () => {
  let report: EvalReport;

  beforeAll(async () => {
    report = await runEvalSuite();
  }, 60_000);

  it("내장 시나리오를 모두 돌린다", () => {
    expect(Object.keys(report.scenarios).sort()).toEqual(["execution-parse", "retry-rate"]);
  });

  it("시나리오의 모든 항목이 관측된다 — 조용히 빠진 항목이 없어야 한다", () => {
    for (const [name, cases] of Object.entries(SCENARIOS)) {
      const observed = report.scenarios[name]?.cases ?? [];
      expect(observed.map(c => c.id).sort(), `${name} 에서 관측되지 않은 항목이 있다`)
        .toEqual(cases.map(c => c.id).sort());
    }
  });

  it("세 판단의 값이 정해진 집합 안에 있다", () => {
    for (const scenario of Object.values(report.scenarios)) {
      for (const c of scenario.cases) {
        expect(EXECUTIONS, `${c.id}: execution`).toContain(c.execution);
        if (c.parse !== null) expect(PARSES, `${c.id}: parse`).toContain(c.parse);
        if (c.task !== null) expect(TASKS, `${c.id}: task`).toContain(c.task);
      }
    }
  });

  it("가드가 막거나 실행이 실패하면 parse·task 를 관측할 수 없다", () => {
    /**
     * 막힌 것은 '실패' 가 아니라 '볼 수 없었다' 다. 관측하지 못한 층에 값을 넣으면
     * 집계가 존재하지 않는 관측을 세게 된다 — 그것이 eval 이 처음에 고치려던 바로 그 오류다.
     */
    for (const scenario of Object.values(report.scenarios)) {
      for (const c of scenario.cases) {
        if (c.execution !== "ran") {
          expect(c.parse, `${c.id}: 막혔는데 parse 가 있다`).toBeNull();
          expect(c.task, `${c.id}: 막혔는데 task 가 있다`).toBeNull();
        } else {
          expect(c.parse, `${c.id}: 실행했는데 parse 가 null 이다`).not.toBeNull();
          expect(c.task, `${c.id}: 실행했는데 task 가 null 이다`).not.toBeNull();
        }
      }
    }
  });

  it("기대가 있는 항목만 판정한다 — 관측값은 기대와 무관하게 센다", () => {
    for (const [name, scenario] of Object.entries(report.scenarios)) {
      const cases = SCENARIOS[name] ?? [];

      for (const level of ["execution", "parse", "task"] as const) {
        const stats = scenario[level];
        const withExpectation = cases.filter(
          c => c.expect?.[level] !== undefined && c.expect.environmentDependent !== true,
        );
        expect(stats.judged, `${name}/${level}: 판정한 개수가 기대가 있는 항목 수와 다르다`)
          .toBe(withExpectation.length);
        expect(stats.matched).toBeLessThanOrEqual(stats.judged);
        expect(stats.matched).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it("관측값 분포의 합이 관측 가능한 항목 수와 같다", () => {
    for (const scenario of Object.values(report.scenarios)) {
      for (const level of ["execution", "parse", "task"] as const) {
        const stats = scenario[level];
        const observed = Object.values(stats.observed).reduce((a, b) => a + b, 0);
        const observable = scenario.cases.filter(c => c[level] !== null).length;
        expect(observed, `${level}: 분포의 합이 실제 관측 수와 다르다`).toBe(observable);
      }
    }
  });

  it("환경에 의존하는 항목은 비율에 넣지 않는다", () => {
    /**
     * `docker ps` 는 이 호스트에 docker 가 있을 수도 없을 수도 있다.
     * 기대를 두지 않고 관측만 남긴다 — 모르는 것을 안다고 적지 않는다.
     */
    const cases = SCENARIOS["execution-parse"] ?? [];
    const dependent = cases.filter(c => c.expect?.environmentDependent === true);
    expect(dependent.length).toBeGreaterThan(0);

    for (const c of dependent) {
      const observed = report.scenarios["execution-parse"]?.cases.find(o => o.id === c.id);
      expect(observed, `${c.id} 가 관측되지 않았다`).toBeDefined();
      expect(observed!.mismatches, `${c.id} 는 판정 대상이 아니다`).toEqual([]);
    }
  });

  it("재실행하지 않는다 — 나중에 만든 파일이 보관본에 보이면 안 된다", () => {
    const c = report.scenarios["retry-rate"]?.cases.find(x => x.id === "no-re-execution");
    expect(c, "재실행 관측 항목이 없다").toBeDefined();
    expect(c!.execution).toBe("ran");
    expect(c!.task).toBe("succeeded");
    expect(c!.mismatches).toEqual([]);
  });

  it("모르는 id 는 사유를 함께 거절한다 — 조용히 새로 실행하지 않는다", () => {
    const c = report.scenarios["retry-rate"]?.cases.find(x => x.id === "unknown-id");
    expect(c, "모르는 id 관측 항목이 없다").toBeDefined();
    expect(c!.task).toBe("succeeded");
    expect(c!.mismatches).toEqual([]);
    expect(c!.note).toContain("거절 사유");
  });
});

// ── 사용자 정의 시나리오 ─────────────────────────────────────────────────

describe("eval 실행 — 사용자 정의 시나리오", () => {
  let dir: string;
  let configPath: string;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "parism-eval-test-"));
    configPath = join(dir, "config.json");
    /**
     * 허용 명령과 허용 경로를 직접 정한다. 그러면 이 호스트에 무엇이 있든
     * 결과가 정해진다 — "이 값이 나온다" 는 주장을 안전하게 할 수 있다.
     */
    await writeFile(configPath, JSON.stringify({
      guard: {
        allowed_commands: ["pwd", "ls"],
        allowed_paths:    [process.cwd()],
        timeout_ms:       10_000,
      },
    }, null, 2));
  }, 30_000);

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("사용자 정의 시나리오를 돌린다", async () => {
    const report = await runEvalSuite({
      configPath,
      scenarios: {
        custom: [
          { id: "pwd-ok", cmd: "pwd", args: [], expect: { execution: "ran", parse: "parsed", task: "succeed" } },
        ],
      },
    });

    const c = report.scenarios["custom"]?.cases[0];
    expect(c).toBeDefined();
    expect(c!.execution).toBe("ran");
    expect(c!.parse).toBe("parsed");
    expect(c!.task).toBe("succeeded");
    expect(c!.mismatches).toEqual([]);
  });

  it("기대와 어긋나면 무엇이 어긋났는지 밝힌다", async () => {
    /**
     * 관측자가 스스로 적은 사유를 지우지 않는다. 비교 결과로 덮어쓰면
     * "무엇이 왜 어긋났는지" 를 아는 사람이 사라지고 'failed — 기대와 다름' 만 남는다.
     */
    const report = await runEvalSuite({
      configPath,
      scenarios: {
        custom: [
          { id: "wrong-expect", cmd: "pwd", args: [], expect: { execution: "blocked" } },
        ],
      },
    });

    const c = report.scenarios["custom"]?.cases[0];
    expect(c!.mismatches.length).toBeGreaterThan(0);
    expect(c!.mismatches.join("\n")).toContain("execution");
    expect(c!.mismatches.join("\n")).toContain("ran");

    const stats = report.scenarios["custom"]!.execution;
    expect(stats.judged).toBe(1);
    expect(stats.matched).toBe(0);
  });

  it("실행되지 않은 항목은 '관측할 수 없었다'고 밝힌다", async () => {
    const report = await runEvalSuite({
      configPath,
      scenarios: {
        custom: [
          { id: "blocked", cmd: "node", args: ["--version"], expect: { parse: "parsed" } },
        ],
      },
    });

    const c = report.scenarios["custom"]?.cases[0];
    expect(c!.execution).toBe("blocked");
    expect(c!.parse).toBeNull();
    expect(c!.mismatches.join("\n")).toContain("관측할 수 없었다");
  });

  it("가드가 막은 것은 실행 실패로 세지 않는다", async () => {
    const report = await runEvalSuite({
      configPath,
      scenarios: {
        custom: [
          { id: "not-allowed", cmd: "node", args: ["--version"], expect: { execution: "blocked" } },
        ],
      },
    });

    const c = report.scenarios["custom"]?.cases[0];
    expect(c!.execution).toBe("blocked");
    expect(c!.mismatches).toEqual([]);
    expect(c!.note).toContain("가드 거절");
  });

  it("environmentDependent 항목은 판정하지 않고 관측만 남긴다", async () => {
    const report = await runEvalSuite({
      configPath,
      scenarios: {
        custom: [
          { id: "dependent", cmd: "pwd", args: [], expect: { environmentDependent: true } },
        ],
      },
    });

    const c = report.scenarios["custom"]?.cases[0];
    expect(c!.mismatches).toEqual([]);

    const stats = report.scenarios["custom"]!.execution;
    expect(stats.judged).toBe(0);
    expect(stats.observed["ran"]).toBe(1);
  });

  it("실패해야 성공인 과제를 그렇게 판정한다", async () => {
    const report = await runEvalSuite({
      configPath,
      scenarios: {
        custom: [
          { id: "missing-file", cmd: "ls", args: ["parism-eval-없는-파일"], expect: { execution: "ran", task: "fail" } },
        ],
      },
    });

    const c = report.scenarios["custom"]?.cases[0];
    expect(c!.task).toBe("failed");
    expect(c!.mismatches).toEqual([]);
  });

  it("선택한 시나리오만 돌린다", async () => {
    const report = await runEvalSuite({
      configPath,
      names: ["custom"],
      scenarios: {
        custom:  [{ id: "a", cmd: "pwd", args: [], expect: { execution: "ran" } }],
        another: [{ id: "b", cmd: "pwd", args: [], expect: { execution: "ran" } }],
      },
    });

    expect(Object.keys(report.scenarios)).toEqual(["custom"]);
  });

  it("알 수 없는 시나리오 이름은 조용히 아무 것도 돌리지 않는다", async () => {
    const report = await runEvalSuite({
      configPath,
      names: ["없는-시나리오"],
      scenarios: { custom: [{ id: "a", cmd: "pwd", args: [] }] },
    });

    /** 빈 보고가 나온다 — 조용한 성공이 아니라 조용한 무실행이다. 호출하는 쪽이 확인해야 한다. */
    expect(Object.keys(report.scenarios)).toEqual([]);
  });
});
