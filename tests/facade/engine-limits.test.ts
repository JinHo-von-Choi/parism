import { describe, it, expect, vi, beforeEach } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir }                     from "node:os";
import path                           from "node:path";
import type { ResponseEnvelope } from "../../src/types/envelope.js";

const state = { active: 0, peak: 0 };

vi.mock("../../src/engine/executor.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/engine/executor.js")>();
  return {
    ...actual,
    execute: vi.fn(async (cmd: string, args: string[], cwd: string): Promise<ResponseEnvelope> => {
      state.active++;
      state.peak = Math.max(state.peak, state.active);
      await new Promise(res => setTimeout(res, 20));
      state.active--;
      return {
        ok: true, exitCode: 0, cmd, args, cwd, duration_ms: 0,
        stdout: { raw: Array.from({ length: 2500 }, (_, i) => `line ${i}`).join("\n") + "\n", parsed: null },
        stderr: { raw: "", parsed: null },
        diff:   null,
      };
    }),
  };
});

const { ParismEngine }               = await import("../../src/facade/engine.js");
const { DEFAULT_CONFIG, loadConfig } = await import("../../src/config/loader.js");
const { createRegistry }             = await import("../../src/parsers/index.js");

describe("실행 동시성 상한", () => {
  beforeEach(() => {
    state.active = 0;
    state.peak   = 0;
  });

  it("기본 상한은 4이고 동시 10건 요청 중 동시 실행은 4건 이하다", async () => {
    expect(DEFAULT_CONFIG.guard.max_concurrency).toBe(4);
    const engine  = new ParismEngine(DEFAULT_CONFIG, createRegistry());
    const results = await Promise.all(Array.from({ length: 10 }, () => engine.run("echo", { args: ["x"] })));
    expect(results.every(r => r.ok)).toBe(true);
    expect(state.peak).toBeLessThanOrEqual(4);
    expect(state.peak).toBeGreaterThan(1);
  });

  it("max_concurrency 설정을 run과 run_paged 모두에 적용한다", async () => {
    const config = { ...DEFAULT_CONFIG, guard: { ...DEFAULT_CONFIG.guard, max_concurrency: 2 } };
    const engine = new ParismEngine(config, createRegistry());
    await Promise.all([
      ...Array.from({ length: 5 }, () => engine.run("echo", { args: ["x"] })),
      ...Array.from({ length: 5 }, (_, i) => engine.runPaged("echo", { args: [`p${i}`] })),
    ]);
    expect(state.peak).toBeLessThanOrEqual(2);
  });

  it("검증하지 않은 설정의 max_concurrency가 1 미만이면 1로, 수가 아니면 기본값으로 본다", async () => {
    for (const [value, expected] of [[0, 1], [-3, 1], [Number.NaN, 4]] as const) {
      state.peak   = 0;
      const config = { ...DEFAULT_CONFIG, guard: { ...DEFAULT_CONFIG.guard, max_concurrency: value } };
      const engine = new ParismEngine(config, createRegistry());
      await Promise.all(Array.from({ length: 6 }, () => engine.run("echo", { args: ["x"] })));
      expect([value, state.peak]).toEqual([value, expected]);
    }
  });
});

describe("run_paged 출력 상한", () => {
  it("상한을 넘는 page_size는 max_page_size로 줄이고 요청값을 표시한다", async () => {
    expect(DEFAULT_CONFIG.guard.max_page_size).toBe(1000);
    const config = { ...DEFAULT_CONFIG, guard: { ...DEFAULT_CONFIG.guard, max_output_bytes: 0 } };
    const r      = await new ParismEngine(config, createRegistry()).runPaged("echo", { args: ["a"], page_size: 5000 });
    expect(r.page_info?.page_size).toBe(1000);
    expect(r.page_info?.requested_page_size).toBe(5000);
    expect(r.stdout.raw.trimEnd().split("\n")).toHaveLength(1000);
    expect(r.page_info?.has_next).toBe(true);
  });

  it("상한 이하 page_size는 그대로 쓰고 요청값 필드를 두지 않는다", async () => {
    const r = await new ParismEngine(DEFAULT_CONFIG, createRegistry()).runPaged("echo", { args: ["b"], page_size: 10 });
    expect(r.page_info?.page_size).toBe(10);
    expect(r.page_info?.requested_page_size).toBeUndefined();
  });

  it("페이지 출력에 max_output_bytes를 적용한다", async () => {
    const config = { ...DEFAULT_CONFIG, guard: { ...DEFAULT_CONFIG.guard, max_output_bytes: 100 } };
    const r      = await new ParismEngine(config, createRegistry()).runPaged("echo", { args: ["c"], page_size: 500 });
    expect(r.truncated).toBe(true);
    expect(r.stdout.raw).toContain("[truncated:");
    expect(Buffer.byteLength(r.stdout.raw)).toBeLessThan(200);
  });
});

describe("default_page_size와 max_page_size", () => {
  it("설정에서 max_page_size보다 큰 default_page_size는 max_page_size로 줄이고, page_size를 주지 않은 요청에는 요청값을 표시하지 않는다", async () => {
    const dir  = mkdtempSync(path.join(tmpdir(), "parism-pagesize-"));
    const file = path.join(dir, "prism.config.json");
    writeFileSync(file, JSON.stringify({ guard: { default_page_size: 5000, max_page_size: 300, max_output_bytes: 0 } }));
    const config = await loadConfig(file);
    expect(config.guard.default_page_size).toBe(300);
    const r = await new ParismEngine(config, createRegistry()).runPaged("echo", { args: ["d"] });
    expect(r.page_info?.page_size).toBe(300);
    expect(r.page_info?.requested_page_size).toBeUndefined();
  });
});
