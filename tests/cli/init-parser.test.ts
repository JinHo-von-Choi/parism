import { describe, it, expect, afterEach } from "vitest";
import { initParser } from "../../src/cli/init-parser.js";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("initParser()", () => {
  const testDir = join(tmpdir(), `parism-init-${Date.now()}`);

  afterEach(() => {
    if (existsSync(testDir)) rmSync(testDir, { recursive: true });
  });

  it("parser pack scaffold를 생성한다 (parser.ts, schema.json, fixtures/)", () => {
    const result = initParser("htop", testDir);

    expect(result.files).toContain(join(testDir, "htop", "parser.ts"));
    expect(result.files).toContain(join(testDir, "htop", "schema.json"));
    expect(existsSync(join(testDir, "htop", "parser.ts"))).toBe(true);
    expect(existsSync(join(testDir, "htop", "schema.json"))).toBe(true);
    expect(existsSync(join(testDir, "htop", "fixtures"))).toBe(true);
  });

  it("parser.ts에 ParserPack export가 포함된다", () => {
    initParser("mycmd", testDir);
    const content = readFileSync(join(testDir, "mycmd", "parser.ts"), "utf-8");

    expect(content).toContain("ParserPack");
    expect(content).toContain('name: "mycmd"');
    expect(content).toContain("export default");
  });

  it("schema.json에 올바른 JSON 스키마가 포함된다", () => {
    initParser("testcmd", testDir);
    const raw     = readFileSync(join(testDir, "testcmd", "schema.json"), "utf-8");
    const schema  = JSON.parse(raw);

    expect(schema.type).toBe("object");
    expect(schema.properties.items.type).toBe("array");
    expect(schema.properties.items.items.type).toBe("string");
  });

  it("InitResult에 name과 files가 포함된다", () => {
    const result = initParser("res", testDir);

    expect(result.name).toBe("res");
    expect(result.files).toHaveLength(2);
  });

  it("이미 존재하는 이름이면 에러를 던진다", () => {
    initParser("dup", testDir);
    expect(() => initParser("dup", testDir)).toThrow(/already exists/);
  });
});
