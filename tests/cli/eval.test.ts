/**
 * `parism eval` 자체의 시험.
 *
 * 실제 명령을 돌리는 항목은 **이 호스트 상태에 따라 달라지므로** 여기서 판정하지 않는다.
 * 대신 **구조**를 고정한다 — 아래가 어긋나면 "판정이 조용히 빠진 것" 으로 이어진다.
 *
 * 작성자: 최진호
 * 작성일: 2026-10-05
 */

import { describe, it, expect } from "vitest";
import { SCENARIOS, SCENARIO_NAMES } from "../../src/cli/eval.js";

describe("eval 시나리오 구조", () => {
  it("알 수 없는 시나리오를 조용히 통과시키지 않는다", () => {
    /** 없는 이름을 주면 아무 것도 돌지 않고 빈 보고가 나온다 — 조용한 성공이 된다 */
    expect(SCENARIOS["없는-시나리오"]).toBeUndefined();
    expect(SCENARIO_NAMES).toContain("execution-parse");
    expect(SCENARIO_NAMES).toContain("retry-rate");
  });

  it("모든 항목에 기대가 있다 — 판정되지 않는 항목이 조용히 남지 않게", () => {
    for (const [name, cases] of Object.entries(SCENARIOS)) {
      for (const c of cases) {
        const judged = c.expect && Object.keys(c.expect).length > 0;
        expect(judged, `${name}/${c.id} 에 기대가 없다 — 관측만 하고 판정하지 않는다`).toBe(true);
      }
    }
  });

  it("항목 id 가 시나리오 안에서 겹치지 않는다", () => {
    for (const [name, cases] of Object.entries(SCENARIOS)) {
      const ids = cases.map(c => c.id);
      expect(new Set(ids).size, `${name} 안에서 id 가 겹친다`).toBe(ids.length);
    }
  });

  it("retry-rate 는 실제로 재실행률을 잰다", () => {
    /**
     * 예전 "retry-rate" 는 `curl -I http://localhost:9999` 같은 명령을 돌려
     * 재시도를 한 번도 세지 않았다. 이름이 재측정과 어긋나면 그것은 거짓말이다.
     */
    const cases = SCENARIOS["retry-rate"] ?? [];
    expect(cases.length).toBeGreaterThan(0);
    for (const c of cases) {
      expect(c.cmd, `retry-rate 항목 '${c.id}' 이 실제 명령이다 — 호스트를 재고 있다`).toMatch(/^@/);
    }
  });

  it("environmentDependent 항목은 기대 항목 이름만 갖는다", () => {
    /** 기대가 있는데 environmentDependent 면 기대가 조용히 무시된다 — 모순이다 */
    for (const cases of Object.values(SCENARIOS)) {
      for (const c of cases) {
        if (c.expect?.environmentDependent !== true) continue;
        const others = Object.entries(c.expect).filter(([k]) => k !== "environmentDependent");
        expect(others, `${c.id} 가 environmentDependent 인데 기대도 있다 — 어느 쪽인지 모호하다`).toEqual([]);
      }
    }
  });
});
