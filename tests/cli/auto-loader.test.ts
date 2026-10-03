import { describe, it, expect, afterEach } from "vitest";
import { loadExternalParsers, externalParserOptions } from "../../src/cli/auto-loader.js";
import { ParserRegistry } from "../../src/parsers/registry.js";
import { mkdirSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("loadExternalParsers()", () => {
  const testDir = join(tmpdir(), `parism-autoloader-${Date.now()}`);

  afterEach(() => {
    if (existsSync(testDir)) rmSync(testDir, { recursive: true });
  });

  it("registry.json에 등록된 파서를 레지스트리에 로드한다", async () => {
    const parsersDir = join(testDir, "parsers", "custom");
    mkdirSync(parsersDir, { recursive: true });

    writeFileSync(join(parsersDir, "parser.js"), `
      export default {
        name: "custom",
        parse: (raw) => ({ custom: true, len: raw.length }),
        schema: { type: "object" },
        fixtures: [],
      };
    `);

    writeFileSync(join(testDir, "registry.json"), JSON.stringify({
      custom: { path: parsersDir, addedAt: "2026-01-01T00:00:00Z" },
    }));

    const registry = new ParserRegistry();
    const loaded = await loadExternalParsers(testDir, registry);

    expect(loaded).toBe(1);
    expect(registry.parse("custom", [], "abc").parsed).toEqual({ custom: true, len: 3 });
  });

  it("registry.json이 없으면 0을 반환한다", async () => {
    mkdirSync(testDir, { recursive: true });
    const registry = new ParserRegistry();
    const loaded = await loadExternalParsers(testDir, registry);
    expect(loaded).toBe(0);
  });

  it("잘못된 파서는 건너뛰고 경고를 출력한다", async () => {
    const parsersDir = join(testDir, "parsers", "broken");
    mkdirSync(parsersDir, { recursive: true });

    writeFileSync(join(parsersDir, "parser.js"), `export const notDefault = 1;`);
    writeFileSync(join(testDir, "registry.json"), JSON.stringify({
      broken: { path: parsersDir, addedAt: "2026-01-01T00:00:00Z" },
    }));

    const registry = new ParserRegistry();
    const loaded = await loadExternalParsers(testDir, registry);
    expect(loaded).toBe(0);
  });

  /** 최상위에서 전역 표식을 남기는 팩을 등록한다. */
  function writeMarkerPack(): void {
    const parsersDir = join(testDir, "parsers", "marker");
    mkdirSync(parsersDir, { recursive: true });
    writeFileSync(join(parsersDir, "parser.js"), `
      globalThis.__parismMarkerLoaded = true;
      export default { name: "marker", parse: (raw) => ({ len: raw.length }), schema: {}, fixtures: [], headerLines: 1 };
    `);
    writeFileSync(join(testDir, "registry.json"), JSON.stringify({
      marker: { path: parsersDir, addedAt: "2026-01-01T00:00:00Z" },
    }));
  }

  it("기본값은 워커 격리라 팩 모듈을 서버 스레드에서 실행하지 않는다", async () => {
    writeMarkerPack();
    const registry = new ParserRegistry();
    try {
      expect(await loadExternalParsers(testDir, registry)).toBe(1);
      expect((globalThis as Record<string, unknown>).__parismMarkerLoaded).toBeUndefined();
      expect(registry.parse("marker", [], "head\nabcd").parsed).toEqual({ len: 9 });
      expect(registry.declaredContract("marker")?.headerLines).toBe(1);
    } finally {
      await registry.close();
    }
  });

  it("isolation=none이면 기존처럼 서버 스레드에서 읽는다", async () => {
    writeMarkerPack();
    const registry = new ParserRegistry();
    try {
      expect(await loadExternalParsers(testDir, registry, { isolation: "none" })).toBe(1);
      expect((globalThis as Record<string, unknown>).__parismMarkerLoaded).toBe(true);
      expect(registry.getPack("marker")?.name).toBe("marker");
    } finally {
      delete (globalThis as Record<string, unknown>).__parismMarkerLoaded;
    }
  });

  it("설정의 parsers 값을 로더 옵션으로 옮긴다", () => {
    expect(externalParserOptions({ external_isolation: "none", external_time_limit_ms: 900, external_memory_limit_mb: 64 }))
      .toEqual({ isolation: "none", timeLimitMs: 900, memoryLimitMb: 64 });
    expect(externalParserOptions(undefined)).toEqual({});
  });
});
