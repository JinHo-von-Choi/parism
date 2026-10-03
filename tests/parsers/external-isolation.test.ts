/**
 * 외부 ParserPack 워커 격리 실행 검사.
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 */

import { describe, it, expect, afterEach, vi } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join }                               from "node:path";
import { tmpdir }                             from "node:os";
import { threadId }                           from "node:worker_threads";
import { loadIsolatedPack, type IsolationLimits } from "../../src/parsers/external/host.js";
import { ParserRegistry }                     from "../../src/parsers/registry.js";
import { ParismEngine }                       from "../../src/facade/engine.js";
import { DEFAULT_CONFIG }                     from "../../src/config/loader.js";

const LIMITS: IsolationLimits = { timeLimitMs: 2000, memoryLimitMb: 64 };

const dirs:       string[]         = [];
const registries: ParserRegistry[] = [];

/** parser.js 하나를 담은 팩 디렉터리를 만든다. */
function writePack(source: string): string {
  const dir = mkdtempSync(join(tmpdir(), "parism-isolated-"));
  writeFileSync(join(dir, "parser.js"), source);
  dirs.push(dir);
  return dir;
}

/** 팩을 격리 실행으로 읽어 새 레지스트리에 등록한다. */
function isolatedRegistry(source: string, limits: IsolationLimits = LIMITS): ParserRegistry {
  const registry = new ParserRegistry();
  registry.registerIsolated(loadIsolatedPack(writePack(source), limits));
  registries.push(registry);
  return registry;
}

/** 소요 시간과 함께 실행한다. */
function timed<T>(fn: () => T): { value: T; ms: number } {
  const start = performance.now();
  const value = fn();
  return { value, ms: performance.now() - start };
}

/** 이벤트 루프를 돌리며 기다린다. */
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/** 이벤트 루프를 돌리지 않고 메인 스레드를 붙잡는다. */
function busyWait(ms: number): void {
  const end = performance.now() + ms;
  while (performance.now() < end) { /* 대기 */ }
}

/** 대기 시간이 지나 워커가 다시 뜰 때까지 같은 호출을 되풀이하고 첫 성공 결과를 돌려준다. */
async function eventually<T>(fn: () => T, ok: (value: T) => boolean, timeoutMs = 3000): Promise<T> {
  const end = performance.now() + timeoutMs;
  for (;;) {
    const value = fn();
    if (ok(value) || performance.now() > end) return value;
    await sleep(25);
  }
}

const FAULTY_PACK = `
  export default {
    name: "faulty",
    parse(raw) {
      if (raw === "loop") for (;;) {}
      if (raw === "exit") process.exit(7);
      if (raw === "oom") { const keep = []; for (;;) keep.push(new Array(1e6).fill(raw.length)); }
      if (raw === "function") return { fn: () => 1 };
      if (raw === "throw") throw new Error("boom");
      if (raw === "unrecognized") throw Object.assign(new Error("nothing usable"), { name: "UnrecognizedOutputError" });
      return { ok: true, raw };
    },
    schema: {},
    fixtures: [],
  };
`;

afterEach(async () => {
  await Promise.all(registries.splice(0).map(r => r.close()));
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("외부 팩 로드", () => {
  it("모듈 최상위 코드는 워커에서만 돌고 계약 선언은 메인 스레드로 넘어온다", () => {
    const registry = isolatedRegistry(`
      globalThis.__parismTopLevel = true;
      export default {
        name: "meta",
        parse: (raw) => ({ lines: raw.split("\\n").length }),
        schema: {},
        fixtures: [],
        headerLines:   1,
        noise:         /^total \\d+/,
        acceptedFlags: { "-l": "bool", "--sort": "value" },
        rowsKey:       "entries",
        rowFields:     ["name"],
      };
    `);

    expect((globalThis as Record<string, unknown>).__parismTopLevel).toBeUndefined();
    const contract = registry.declaredContract("meta");
    expect(contract?.headerLines).toBe(1);
    expect(contract?.noise).toBeInstanceOf(RegExp);
    expect(contract?.noise?.test("total 12")).toBe(true);
    expect(contract?.acceptedFlags).toEqual({ "-l": "bool", "--sort": "value" });
    expect(contract?.rowFields).toEqual(["name"]);
    expect(registry.hasParser("meta")).toBe(true);
    expect(registry.listPacks()).toContain("meta");
  });

  it("parse는 메인 스레드가 아닌 워커 스레드에서 실행된다", () => {
    const registry = isolatedRegistry(`
      import { threadId } from "node:worker_threads";
      export default { name: "where", parse: (raw) => ({ thread: threadId, len: raw.length }), schema: {}, fixtures: [] };
    `);

    const parsed = registry.parse("where", [], "abc").parsed as { thread: number; len: number };
    expect(parsed.len).toBe(3);
    expect(parsed.thread).not.toBe(threadId);
  });

  it("계약의 함수 선언(supports, hint)은 호출마다 워커에서 평가한다", () => {
    const registry = isolatedRegistry(`
      export default {
        name: "fn",
        parse: () => ({ ok: true }),
        schema: {},
        fixtures: [],
        supports: (args) => { globalThis.__parismSupportsCalls = (globalThis.__parismSupportsCalls ?? 0) + 1; return !args.includes("--bad"); },
        hint:     () => ({ args: ["--good"], reason: "use --good" }),
      };
    `);

    const rejected = registry.parse("fn", ["--bad"], "x");
    expect(rejected.parse_error?.reason).toBe("unsupported_format");
    expect(rejected.parse_error?.hint).toEqual({ args: ["--good"], reason: "use --good" });
    expect(registry.parse("fn", ["--good"], "x").parsed).toEqual({ ok: true });
    expect((globalThis as Record<string, unknown>).__parismSupportsCalls).toBeUndefined();
  });

  it("parser.js가 없거나 기본 내보내기가 ParserPack이 아니면 로드하지 않는다", () => {
    const empty = mkdtempSync(join(tmpdir(), "parism-isolated-"));
    dirs.push(empty);
    expect(() => loadIsolatedPack(empty, LIMITS)).toThrow(/parser\.js not found/);
    expect(() => loadIsolatedPack(writePack("export const notDefault = 1;"), LIMITS)).toThrow(/Invalid default export/);
  });

  it("모듈 최상위가 끝나지 않으면 기동 상한 안에서 로드를 포기한다", () => {
    const dir = writePack("for (;;) {}\nexport default {};");
    const run = timed(() => {
      try { loadIsolatedPack(dir, { ...LIMITS, startupTimeoutMs: 300 }); return null; } catch (err) { return err as Error; }
    });
    expect(run.value?.message).toMatch(/did not start within 300 ms/);
    expect(run.ms).toBeLessThan(2000);
  });
});

describe("외부 팩 출력", () => {
  it("팩의 console 출력은 stdout이 아닌 stderr로 간다", async () => {
    const out: string[] = [];
    const err: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => { out.push(String(chunk)); return true; });
    vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => { err.push(String(chunk)); return true; });
    const registry = isolatedRegistry(`
      export default { name: "noisy", parse: (raw) => { console.log("pack-noise-" + raw); return { raw }; }, schema: {}, fixtures: [] };
    `);

    registry.parse("noisy", [], "1");
    for (let i = 0; i < 50 && !err.some(w => w.includes("pack-noise-1")); i++) {
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    expect(err.some(w => w.includes("pack-noise-1"))).toBe(true);
    expect(out.some(w => w.includes("pack-noise-1"))).toBe(false);
  });

  it("팩이 process.stdout.write로 쓴 출력도 stdout이 아닌 stderr로 간다", async () => {
    const out: string[] = [];
    const err: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => { out.push(String(chunk)); return true; });
    vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => { err.push(String(chunk)); return true; });
    const registry = isolatedRegistry(`
      export default { name: "rawout", parse: (raw) => { process.stdout.write("pack-raw-" + raw + "\\n"); return { ok: true, raw }; }, schema: {}, fixtures: [] };
    `);

    expect(registry.parse("rawout", [], "1").parsed).toEqual({ ok: true, raw: "1" });
    for (let i = 0; i < 50 && !err.some(w => w.includes("pack-raw-1")); i++) {
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    expect(err.some(w => w.includes("pack-raw-1"))).toBe(true);
    expect(out.some(w => w.includes("pack-raw-1"))).toBe(false);
  });
});

describe("외부 팩 실행 실패", () => {
  it("파서 예외는 parser_exception, UnrecognizedOutputError 이름의 예외는 unrecognized_output이다", () => {
    const registry = isolatedRegistry(FAULTY_PACK);
    expect(registry.parse("faulty", [], "throw").parse_error).toEqual({ reason: "parser_exception", message: "boom" });
    expect(registry.parse("faulty", [], "unrecognized").parse_error).toEqual({ reason: "unrecognized_output", message: "nothing usable" });
  });

  it("구조화 복제할 수 없는 반환값은 parser_exception이다", () => {
    const registry = isolatedRegistry(FAULTY_PACK);
    const result   = registry.parse("faulty", [], "function");
    expect(result.parsed).toBeNull();
    expect(result.parse_error?.reason).toBe("parser_exception");
    expect(result.parse_error?.message).toMatch(/cannot be passed between threads/);
    expect(registry.parse("faulty", [], "next").parsed).toEqual({ ok: true, raw: "next" });
  });

  it("끝나지 않는 parse는 시간 상한 안에서 parser_exception으로 끝나고 대기 시간 뒤 호출은 새 워커가 처리한다", async () => {
    const registry = isolatedRegistry(FAULTY_PACK, { ...LIMITS, timeLimitMs: 300, cooldownMs: 50 });
    const run      = timed(() => registry.parse("faulty", [], "loop"));

    expect(run.value.parsed).toBeNull();
    expect(run.value.parse_error?.reason).toBe("parser_exception");
    expect(run.value.parse_error?.message).toMatch(/did not answer within 300 ms/);
    expect(run.ms).toBeGreaterThanOrEqual(290);
    expect(run.ms).toBeLessThan(2000);
    const after = await eventually(() => registry.parse("faulty", [], "after"), r => r.parsed !== null);
    expect(after.parsed).toEqual({ ok: true, raw: "after" });
  });

  it("워커가 스스로 끝나면 시간 상한을 기다리지 않고 parser_exception이며 대기 시간 뒤 호출은 다시 띄운 워커가 처리한다", async () => {
    const registry = isolatedRegistry(FAULTY_PACK, { ...LIMITS, timeLimitMs: 5000, cooldownMs: 50 });
    const run      = timed(() => registry.parse("faulty", [], "exit"));

    expect(run.value.parse_error?.reason).toBe("parser_exception");
    expect(run.value.parse_error?.message).toMatch(/stopped/);
    expect(run.ms).toBeLessThan(2000);
    const again = await eventually(() => registry.parse("faulty", [], "again"), r => r.parsed !== null);
    expect(again.parsed).toEqual({ ok: true, raw: "again" });
  });

  it("메모리 상한을 넘긴 워커는 멈추고 parser_exception이며 대기 시간 뒤 호출은 처리된다", async () => {
    const writes: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => { writes.push(String(chunk)); return true; });
    const registry = isolatedRegistry(FAULTY_PACK, { timeLimitMs: 1500, memoryLimitMb: 32, cooldownMs: 50 });

    const result = registry.parse("faulty", [], "oom");
    expect(result.parse_error?.reason).toBe("parser_exception");

    for (let i = 0; i < 50 && !writes.some(w => w.includes("ERR_WORKER_OUT_OF_MEMORY")); i++) {
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    expect(writes.some(w => w.includes("ERR_WORKER_OUT_OF_MEMORY"))).toBe(true);
    const fine = await eventually(() => registry.parse("faulty", [], "fine"), r => r.parsed !== null);
    expect(fine.parsed).toEqual({ ok: true, raw: "fine" });
  });

  it("호출 사이에 워커가 끝나면 다음 호출은 시간 상한을 기다리지 않고 parser_exception이다", () => {
    const registry = isolatedRegistry(`
      export default {
        name: "fading",
        parse(raw) { if (raw === "fade") setTimeout(() => process.exit(4), 0); return { ok: true, raw }; },
        schema: {},
        fixtures: [],
      };
    `, { ...LIMITS, timeLimitMs: 1500 });

    expect(registry.parse("fading", [], "fade").parsed).toEqual({ ok: true, raw: "fade" });
    busyWait(300);
    const next = timed(() => registry.parse("fading", [], "next"));
    expect(next.value.parse_error?.reason).toBe("parser_exception");
    expect(next.value.parse_error?.message).toMatch(/stopped unexpectedly/);
    expect(next.ms).toBeLessThan(500);
  });
});

describe("외부 팩 장애 뒤 대기", () => {
  /** 두 번째 로드부터 모듈 최상위가 1500ms 걸리는 팩. "exit" 입력은 워커를 끝낸다. */
  const SLOW_RESTART_PACK = `
    import { existsSync, writeFileSync } from "node:fs";
    const marker = new URL("./loaded-once", import.meta.url);
    if (existsSync(marker)) { const end = Date.now() + 1500; while (Date.now() < end) { /* 지연 */ } }
    else writeFileSync(marker, "");
    export default {
      name: "slowstart",
      parse(raw) { if (raw === "exit") process.exit(3); return { ok: true, raw }; },
      schema: {},
      fixtures: [],
    };
  `;

  it("대기 시간 동안 호출은 워커를 띄우지 않고 바로 parser_exception이며 다시 띄우는 동안에도 호출 하나는 시간 상한을 넘지 않는다", async () => {
    const limits   = { ...LIMITS, timeLimitMs: 300, startupTimeoutMs: 1000, cooldownMs: 400, cooldownMaxMs: 5000 };
    const registry = isolatedRegistry(SLOW_RESTART_PACK, limits);

    expect(registry.parse("slowstart", [], "exit").parse_error?.message).toMatch(/stopped/);

    for (let i = 0; i < 5; i++) {
      const paused = timed(() => registry.parse("slowstart", [], "x"));
      expect(paused.value.parse_error?.reason).toBe("parser_exception");
      expect(paused.value.parse_error?.message).toMatch(/paused/);
      expect(paused.ms).toBeLessThan(50);
    }

    await sleep(450);
    const messages: string[] = [];
    let   longest            = 0;
    const end                = performance.now() + 1800;
    while (performance.now() < end) {
      const call = timed(() => registry.parse("slowstart", [], "x"));
      longest    = Math.max(longest, call.ms);
      messages.push(call.value.parse_error?.message ?? "ok");
      await sleep(10);
    }

    expect(longest).toBeLessThan(limits.timeLimitMs + 150);
    expect(messages.some(m => /still starting/.test(m))).toBe(true);
    expect(messages.some(m => /did not start within 1000 ms/.test(m))).toBe(true);
  });

  it("장애가 이어지면 대기 시간이 두 배씩 늘고 최대값에서 멈춘다", async () => {
    const registry = isolatedRegistry(FAULTY_PACK, { ...LIMITS, cooldownMs: 100, cooldownMaxMs: 300 });
    const pauses: string[] = [];
    for (let i = 0; i < 4; i++) {
      const failed = await eventually(() => registry.parse("faulty", [], "exit"), r => !/paused/.test(r.parse_error?.message ?? ""));
      pauses.push(/restarts after (\d+) ms/.exec(failed.parse_error?.message ?? "")?.[1] ?? "none");
    }
    expect(pauses).toEqual(["100", "200", "300", "300"]);
  });

  it("성공한 호출은 대기 시간을 처음 값으로 되돌린다", async () => {
    const registry = isolatedRegistry(FAULTY_PACK, { ...LIMITS, cooldownMs: 100, cooldownMaxMs: 1000 });
    expect(registry.parse("faulty", [], "exit").parse_error?.message).toMatch(/restarts after 100 ms/);
    const second = await eventually(() => registry.parse("faulty", [], "exit"), r => !/paused/.test(r.parse_error?.message ?? ""));
    expect(second.parse_error?.message).toMatch(/restarts after 200 ms/);

    const fine = await eventually(() => registry.parse("faulty", [], "fine"), r => r.parsed !== null);
    expect(fine.parsed).toEqual({ ok: true, raw: "fine" });
    expect(registry.parse("faulty", [], "exit").parse_error?.message).toMatch(/restarts after 100 ms/);
  });

  it("호출 하나의 계약 함수와 parse 왕복은 시간 상한 하나를 함께 쓴다", () => {
    const registry = isolatedRegistry(`
      function spin(ms) { const end = Date.now() + ms; while (Date.now() < end) { /* 지연 */ } }
      export default {
        name: "slowcontract",
        parse(raw) { spin(200); return { ok: true, raw }; },
        schema: {},
        fixtures: [],
        supports(args) { spin(200); return !args.includes("--bad"); },
        hint() { spin(200); return { args: ["--good"], reason: "use --good" }; },
      };
    `, { ...LIMITS, timeLimitMs: 300, cooldownMs: 10 });

    const accepted = timed(() => registry.parse("slowcontract", [], "x"));
    expect(accepted.value.parse_error?.reason).toBe("parser_exception");
    expect(accepted.ms).toBeLessThan(300 + 150);
  });
});

describe("strict_schemas와 외부 팩", () => {
  const SCHEMA_PACK = `
    export default {
      name: "typed",
      parse: (raw) => ({ ok: raw === "good", input: raw }),
      schema: {
        safeParse: (value) => value.ok === true
          ? { success: true, data: value }
          : { success: false, error: { issues: [{ path: ["ok"], message: "Expected true" }] } },
      },
      fixtures: [],
    };
  `;

  it("strict 검사는 워커에서 팩 스키마로 수행하고 위반은 schema_violation이다", () => {
    const registry = isolatedRegistry(SCHEMA_PACK);
    expect(registry.parse("typed", [], "bad", undefined, true).parse_error).toEqual({ reason: "schema_violation", message: "ok: Expected true" });
    expect(registry.parse("typed", [], "good", undefined, true).parsed).toEqual({ ok: true, input: "good" });
    expect(registry.parse("typed", [], "bad", undefined, false).parsed).toEqual({ ok: false, input: "bad" });
  });
});

describe("엔진과 외부 팩 격리", () => {
  it("끝나지 않는 외부 파서가 있어도 엔진은 다음 요청에 응답한다", async () => {
    const registry = isolatedRegistry(`
      export default {
        name: "echo",
        parse(raw) { if (raw.startsWith("loop")) for (;;) {} return { text: raw.trim() }; },
        schema: {},
        fixtures: [],
      };
    `, { ...LIMITS, timeLimitMs: 300, cooldownMs: 200 });
    const engine = new ParismEngine(DEFAULT_CONFIG, registry);

    const stuck = await engine.run("echo", { args: ["loop"] });
    expect(stuck.stdout.parsed).toBeNull();
    expect(stuck.stdout.parse_error?.reason).toBe("parser_exception");

    const paused = await engine.run("echo", { args: ["hello"] });
    expect(paused.stdout.parse_error?.message).toMatch(/paused/);

    await sleep(250);
    let next = await engine.run("echo", { args: ["hello"] });
    for (let i = 0; i < 40 && next.stdout.parsed === null; i++) {
      await sleep(25);
      next = await engine.run("echo", { args: ["hello"] });
    }
    expect(next.stdout.parsed).toEqual({ text: "hello" });
  });

  it("투영 단계에서 계약 함수가 실패해도 엔진은 응답 봉투를 돌려준다", async () => {
    const registry = isolatedRegistry(`
      let calls = 0;
      export default {
        name: "echo",
        parse: (raw) => ({ rows: [{ text: raw.trim() }] }),
        schema: {},
        fixtures: [],
        supports() { calls++; if (calls % 2 === 0) throw new Error("supports failed"); return true; },
      };
    `);
    const engine = new ParismEngine(DEFAULT_CONFIG, registry);

    const run = await engine.run("echo", { args: ["hello"], select: ["text"] });
    expect(run.stdout.parsed).toMatchObject({ rows: [{ text: "hello" }] });
  });
});
