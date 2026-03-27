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
});
