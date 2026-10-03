import { describe, it, expect, afterEach } from "vitest";
import { addParserPack } from "../../src/cli/add.js";
import { mkdirSync, writeFileSync, existsSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("addParserPack()", () => {
  const testDir   = join(tmpdir(), `parism-add-${Date.now()}`);
  const sourceDir = join(testDir, "source");
  const homeDir   = join(testDir, "home");

  afterEach(() => {
    if (existsSync(testDir)) rmSync(testDir, { recursive: true });
  });

  it("파서 팩을 ~/.parism/parsers/에 복사하고 registry.json에 등록한다", async () => {
    mkdirSync(join(sourceDir, "myparser"), { recursive: true });
    writeFileSync(join(sourceDir, "myparser", "parser.js"), `
      export default {
        name: "myparser",
        parse: (raw) => ({ data: raw }),
        schema: { type: "object" },
        fixtures: [],
      };
    `);

    const result = await addParserPack(join(sourceDir, "myparser"), homeDir);

    expect(result.name).toBe("myparser");
    expect(existsSync(join(homeDir, "parsers", "myparser", "parser.js"))).toBe(true);

    const registryPath = join(homeDir, "registry.json");
    expect(existsSync(registryPath)).toBe(true);

    const registry = JSON.parse(readFileSync(registryPath, "utf-8"));
    expect(registry).toHaveProperty("myparser");
  });

  it("팩 이름은 워커에서 읽어 모듈 최상위 코드를 CLI 스레드에서 실행하지 않는다", async () => {
    mkdirSync(join(sourceDir, "marked"), { recursive: true });
    writeFileSync(join(sourceDir, "marked", "parser.js"), `
      globalThis.__parismAddTopLevel = true;
      export default { name: "marked", parse: (raw) => ({ data: raw }), schema: {}, fixtures: [] };
    `);

    const result = await addParserPack(join(sourceDir, "marked"), homeDir);

    expect(result.name).toBe("marked");
    expect((globalThis as Record<string, unknown>).__parismAddTopLevel).toBeUndefined();
  });

  it("ParserPack이 아닌 기본 내보내기는 등록하지 않는다", async () => {
    mkdirSync(join(sourceDir, "broken"), { recursive: true });
    writeFileSync(join(sourceDir, "broken", "parser.js"), "export const notDefault = 1;");

    await expect(addParserPack(join(sourceDir, "broken"), homeDir)).rejects.toThrow(/Invalid default export/);
    expect(existsSync(join(homeDir, "registry.json"))).toBe(false);
  });

  it("이름이 형식 밖인 팩은 디렉터리를 만들기 전에 거부한다", async () => {
    for (const [dir, name] of [["dots", ".."], ["empty", ""], ["proto", "__proto__"], ["nested", "a/b"], ["leading", ".hidden"], ["long", "a".repeat(65)]]) {
      mkdirSync(join(sourceDir, dir), { recursive: true });
      writeFileSync(join(sourceDir, dir, "parser.js"), `
        export default { name: ${JSON.stringify(name)}, parse: (raw) => ({ data: raw }), schema: {}, fixtures: [] };
      `);
      await expect(addParserPack(join(sourceDir, dir), homeDir), name).rejects.toThrow(/Invalid parser pack name/);
    }
    expect(existsSync(homeDir)).toBe(false);
  });
});
