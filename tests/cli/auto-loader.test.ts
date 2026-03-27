import { describe, it, expect, afterEach } from "vitest";
import { loadExternalParsers } from "../../src/cli/auto-loader.js";
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
});
