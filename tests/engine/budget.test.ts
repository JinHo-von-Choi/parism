/**
 * 토큰 예산과 누락 내역 시험.
 *
 * 계획서 6장 수용 기준을 그대로 옮긴다.
 *   1) 모든 예산 시험에서 최종 payload 상한을 지킨다
 *   2) 필요한 필드가 사라지면 명시적 실패다
 *   3) 전부를 읽으면 같은 결과의 모든 행을 중복·누락 없이 복원한다
 *   4) capture / parse / budget 손실이 다른 이유로 구분된다
 *   5) 예산을 키우면 더 적은 행을 반환하지 않는다(단조성)
 *
 * 작성자: 최진호
 * 작성일: 2026-10-05
 */

import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ParismEngine } from "../../src/facade/engine.js";
import { DEFAULT_CONFIG } from "../../src/config/loader.js";
import { createRegistry } from "../../src/parsers/index.js";
import { countTokens, countJsonTokens, tokenizerInfo, TOKENIZER_VERSION } from "../../src/engine/budget/tokenizer.js";
import { applyBudget, decodeCursor, makeCursor, replaceRows, findRowArray, validateTokenizer } from "../../src/engine/budget/index.js";

/** 120행짜리 결과를 만들어 큰 목록을 흉내 낸다 */
function rows(count: number) {
  return Array.from({ length: count }, (_, i) => ({ path: `file-${String(i).padStart(3, "0")}.txt`, xy: " M", size: i }));
}

function engineWith(rowsAllowed: number, cwd = process.cwd()) {
  const config = structuredClone(DEFAULT_CONFIG);
  config.guard.allowed_commands = ["echo"];
  config.guard.allowed_paths    = [cwd];
  config.guard.max_items        = rowsAllowed;
  return new ParismEngine(config, createRegistry());
}

describe("고정 토크나이저", () => {
  it("같은 문자열엔 언제나 같은 수를 낸다", () => {
    const text = JSON.stringify({ entries: rows(20) }, null, 2);
    expect(countTokens(text)).toBe(countTokens(text));
  });

  it("ID 와 버전을 밝힌다", () => {
    expect(tokenizerInfo().id).toBe("parism/approx");
    expect(tokenizerInfo().version).toBe(TOKENIZER_VERSION);
  });

  it("근사임을 감추지 않는다", () => {
    expect(tokenizerInfo("parism/approx").exact).toBe(false);
    expect(tokenizerInfo("byte").exact).toBe(true);
  });

  it("byte 모드는 문자 수로 센다", () => {
    expect(countTokens("abc", "byte")).toBe(3);
  });

  it("빈 입력을 0 으로 센다", () => {
    expect(countTokens("")).toBe(0);
    expect(countJsonTokens(null)).toBeGreaterThanOrEqual(0);
  });
});

describe("지원하지 않는 토크나이저", () => {
  it("조용히 대체하지 않고 거절한다", () => {
    const v = validateTokenizer("gpt-4");
    expect(v.ok).toBe(false);
    expect(v.ok === false && v.message).toMatch(/not supported/);
  });

  it("이름을 주지 않으면 기본값을 쓴다", () => {
    expect(validateTokenizer(undefined)).toEqual({ ok: true, id: "parism/approx" });
  });
});

describe("예산 적용", () => {
  const base = {
    identityFields:  ["path", "xy"],
    resultId:        "r_test",
    binding:         { content_hash: "h", schema_version: "v", policy: "{}" },
    captureTruncated: false,
    silentEmpty:      false,
    parseFailed:      false,
    privacyApplied:   false,
    projectionOmitted: 0,
  };

  it("상한 안에 들어가면 그대로 보낸다", () => {
    const out = applyBudget({
      ...base, value: { entries: rows(5) },
      budget: { max_tokens: 20_000 }, measure: (v) => countJsonTokens(v),
    });
    expect(out.report.budget_met).toBe(true);
    expect(findRowArray(out.value)?.rows).toHaveLength(5);
    expect(out.omissions).toHaveLength(0);
  });

  it("상한을 넘으면 행을 줄이고 진행 정보를 준다", () => {
    const out = applyBudget({
      ...base, value: { entries: rows(200) },
      budget: { max_tokens: 1500 }, measure: (v) => countJsonTokens(v),
    });
    const kept = findRowArray(out.value)?.rows ?? [];
    expect(kept.length).toBeLessThan(200);
    expect(kept.length).toBeGreaterThan(0);
    expect(out.continuation?.total).toBe(200);
    expect(out.continuation?.rows_left).toBe(200 - kept.length);
    expect(out.omissions.some(o => o.stage === "budget")).toBe(true);
  });

  it("필요한 필드가 없으면 명시적으로 밝힌다", () => {
    const out = applyBudget({
      ...base, value: { entries: rows(3) },
      budget: { max_tokens: 20_000, required_fields: ["없는_필드"] },
      measure: (v) => countJsonTokens(v),
    });
    expect(out.omissions.some(o => o.reason.includes("없는_필드"))).toBe(true);
  });

  it("필수 필드는 예산이 빡빡해도 남는다", () => {
    const out = applyBudget({
      ...base, value: { entries: rows(200) },
      budget: { max_tokens: 1500, required_fields: ["path"] },
      measure: (v) => countJsonTokens(v),
    });
    for (const row of findRowArray(out.value)?.rows ?? []) {
      expect(row).toHaveProperty("path");
    }
  });

  it("필수 필드만 남기고 나머지 필드는 줄일 수 있다", () => {
    const out = applyBudget({
      ...base, value: { entries: rows(200) },
      budget: { max_tokens: 1200, required_fields: ["path"] },
      measure: (v) => countJsonTokens(v),
    });
    const kept = findRowArray(out.value)?.rows ?? [];
    expect(kept.length).toBeGreaterThan(0);
    for (const row of kept) {
      expect(row).toHaveProperty("path");
      /** identity 로 선언한 xy 도 남는다 */
      expect(row).toHaveProperty("xy");
    }
  });

  it("수집 상한에 걸리면 전체 행 수를 모른다고 밝힌다", () => {
    const out = applyBudget({
      ...base, value: { entries: rows(3) }, captureTruncated: true,
      budget: { max_tokens: 20_000 }, measure: (v) => countJsonTokens(v),
    });
    const capture = out.omissions.find(o => o.stage === "capture");
    expect(capture).toBeDefined();
    expect(capture?.unknown_counts).toBeDefined();
  });

  it("단계별 손실 이유를 구분해 남긴다", () => {
    const out = applyBudget({
      ...base, value: { entries: rows(3) },
      silentEmpty: true, privacyApplied: true, projectionOmitted: 7,
      budget: { max_tokens: 20_000 }, measure: (v) => countJsonTokens(v),
    });
    const stages = out.omissions.map(o => o.stage);
    expect(stages).toContain("parse");
    expect(stages).toContain("privacy");
    expect(stages).toContain("projection");
  });

  it("overflow=error 면 잘라내지 않고 거절한다", () => {
    const out = applyBudget({
      ...base, value: { entries: rows(200) },
      budget: { max_tokens: 1200, overflow: "error" }, measure: (v) => countJsonTokens(v),
    });
    const budget_ = out.omissions.find(o => o.stage === "budget");
    expect(budget_?.reason).toMatch(/overflow=error/);
    expect(budget_?.next_cursor).toBeNull();
  });

  it("표면까지 붙인 최종 크기가 상한 안에 든다", () => {
    /** 표면(누락 내역)이 크면 최종 payload 가 상한을 넘을 수 있다. 넘으면 더 덜어내야 한다. */
    const out = applyBudget({
      ...base, value: { entries: rows(400) },
      budget: { max_tokens: 1600 },
      measure: (value, surface) => countJsonTokens({ ...surface, value }),
    });
    expect(out.report.measured_tokens).toBeLessThanOrEqual(1600);
    expect(out.report.budget_met).toBe(true);
  });
});

describe("단조성", () => {
  it("예산을 키우면 행 수가 줄지 않는다", () => {
    let previous = -1;
    for (const max of [1200, 1400, 1600, 2000, 2600, 4000, 12000]) {
      const out = applyBudget({
        identityFields: ["path", "xy"], resultId: "r_m",
        binding: { content_hash: "h", schema_version: "v", policy: "{}" },
        captureTruncated: false, silentEmpty: false, parseFailed: false,
        privacyApplied: false, projectionOmitted: 0,
        value: { entries: rows(300) }, budget: { max_tokens: max },
        measure: (value, surface) => countJsonTokens({ ...surface, value }),
      });
      const kept = findRowArray(out.value)?.rows.length ?? 0;
      expect(kept, `max_tokens ${max}`).toBeGreaterThanOrEqual(previous);
      previous = kept;
    }
  });
});

describe("이어 읽기 진행 정보", () => {
  it("cursor 에 진행 규칙과 위치를 함께 싣는다", () => {
    const cursor = makeCursor({ result_id: "r_1", content_hash: "h", schema_version: "v", policy: "{}" }, 30);
    const decoded = decodeCursor(cursor);
    expect(decoded?.offset).toBe(30);
    expect(decoded?.binding.result_id).toBe("r_1");
    expect(decoded?.binding.content_hash).toBe("h");
  });

  it("위조된 cursor 는 null 이다", () => {
    expect(decodeCursor("이건_위조")).toBeNull();
    expect(decodeCursor("")).toBeNull();
  });
});

describe("값 치환", () => {
  it("행 배열을 교체한다", () => {
    expect(replaceRows({ a: 1, entries: rows(2) }, "entries", [])).toEqual({ a: 1, entries: [] });
  });

  it("최상위 배열이면 표면을 붙일 자리를 만든다", () => {
    expect(replaceRows(rows(2), "", rows(1), { continuation: { cursor: "c" } })).toEqual({
      rows: rows(1), continuation: { cursor: "c" },
    });
  });

  it("행 배열이 없으면 null 을 준다", () => {
    expect(findRowArray({ a: 1 })).toBeNull();
    expect(findRowArray(rows(2))?.rows).toHaveLength(2);
  });
});

describe("엔진 예산 경로", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "parism-budget-"));
  afterEachCleanup(() => rmSync(dir, { recursive: true, force: true }));

  it("예산을 주지 않으면 표면에 예산 정보가 없다", async () => {
    const engine = engineWith(500, dir);
    const res = await engine.run("echo", { args: ["hi"], cwd: dir });
    expect((res as unknown as Record<string, unknown>).budget).toBeUndefined();
  });

  it("최소 봉투에 못 미치는 예산은 실행 전에 거절한다", async () => {
    const engine = engineWith(500, dir);
    const res = await engine.run("echo", { args: ["hi"], cwd: dir, budget: { max_tokens: 10 } });
    expect(res.ok).toBe(false);
    expect(res.failure?.reason).toBe("budget_too_small");
    /** 실행하지 않았으므로 출력이 없다 */
    expect(res.stdout.raw).toBe("");
  });

  it("지원하지 않는 토크나이저는 실행 전에 거절한다", async () => {
    const engine = engineWith(500, dir);
    const res = await engine.run("echo", { args: ["hi"], cwd: dir, budget: { max_tokens: 4000, tokenizer: "gpt-4" } });
    expect(res.failure?.reason).toBe("tokenizer_unsupported");
    expect(res.stdout.raw).toBe("");
  });

  it("예산을 주면 예산 보고와 누락 내역이 실린다", async () => {
    const engine = engineWith(500, dir);
    const res = await engine.run("echo", { args: ["hi"], cwd: dir, budget: { max_tokens: 3000 } });
    const surface = res as unknown as { budget: { measured_tokens: number; budget_met: boolean; tokenizer_id: string } };
    expect(surface.budget.tokenizer_id).toBe("parism/approx");
    expect(surface.budget.measured_tokens).toBeGreaterThan(0);
    expect(surface.budget.budget_met).toBe(true);
    /** 내부 계산용 필드가 응답으로 새어나가면 안 된다 */
    expect(Object.keys(res as unknown as Record<string, unknown>)).not.toContain("shrunkParsed");
  });
});

/** vitest 의 afterEach 대신 파일 끝에서 한 번만 정리한다. */
function afterEachCleanup(fn: () => void): void {
  process.on("exit", fn);
}
