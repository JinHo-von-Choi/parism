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

  it("끝나지 않는 parse는 시간 상한 안에서 parser_exception으로 끝나고 다음 호출은 새 워커가 처리한다", () => {
    const registry = isolatedRegistry(FAULTY_PACK, { ...LIMITS, timeLimitMs: 300 });
    const run      = timed(() => registry.parse("faulty", [], "loop"));

    expect(run.value.parsed).toBeNull();
    expect(run.value.parse_error?.reason).toBe("parser_exception");
    expect(run.value.parse_error?.message).toMatch(/did not answer within 300 ms/);
    expect(run.ms).toBeGreaterThanOrEqual(290);
    expect(run.ms).toBeLessThan(2000);
    expect(registry.parse("faulty", [], "after").parsed).toEqual({ ok: true, raw: "after" });
  });

  it("워커가 스스로 끝나면 시간 상한을 기다리지 않고 parser_exception이며 두 번째 호출은 다시 띄운 워커가 처리한다", () => {
    const registry = isolatedRegistry(FAULTY_PACK, { ...LIMITS, timeLimitMs: 5000 });
    const run      = timed(() => registry.parse("faulty", [], "exit"));

    expect(run.value.parse_error?.reason).toBe("parser_exception");
    expect(run.value.parse_error?.message).toMatch(/stopped/);
    expect(run.ms).toBeLessThan(2000);
    expect(registry.parse("faulty", [], "again").parsed).toEqual({ ok: true, raw: "again" });
  });

  it("메모리 상한을 넘긴 워커는 멈추고 parser_exception이며 다음 호출은 처리된다", async () => {
    const writes: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => { writes.push(String(chunk)); return true; });
    const registry = isolatedRegistry(FAULTY_PACK, { timeLimitMs: 1500, memoryLimitMb: 32 });

    const result = registry.parse("faulty", [], "oom");
    expect(result.parse_error?.reason).toBe("parser_exception");

    for (let i = 0; i < 50 && !writes.some(w => w.includes("ERR_WORKER_OUT_OF_MEMORY")); i++) {
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    expect(writes.some(w => w.includes("ERR_WORKER_OUT_OF_MEMORY"))).toBe(true);
    expect(registry.parse("faulty", [], "fine").parsed).toEqual({ ok: true, raw: "fine" });
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
    `, { ...LIMITS, timeLimitMs: 300 });
    const engine = new ParismEngine(DEFAULT_CONFIG, registry);

    const stuck = await engine.run("echo", { args: ["loop"] });
    expect(stuck.stdout.parsed).toBeNull();
    expect(stuck.stdout.parse_error?.reason).toBe("parser_exception");

    const next = await engine.run("echo", { args: ["hello"] });
    expect(next.stdout.parsed).toEqual({ text: "hello" });
  });
});
