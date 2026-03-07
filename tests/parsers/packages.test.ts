import { describe, it, expect } from "vitest";
import { parseNpm }   from "../../src/parsers/packages/npm.js";
import { parseCargo } from "../../src/parsers/packages/cargo.js";

describe("parseNpm()", () => {
  const raw = [
    "@nerdvana/parism@0.2.0 /home/nirna/job/nerdvana-prism",
    "├── @eslint/js@10.0.1",
    "├── typescript@5.9.3",
    "└── zod@3.25.76",
  ].join("\n");

  it("트리 형식 아닐 때 { lines } 폴백", () => {
    const result = parseNpm("npm", [], "plain output\nno tree") as { lines: string[] };
    expect(result.lines).toEqual(["plain output", "no tree"]);
  });

  it("npm list 트리 출력을 파싱한다", () => {
    const result = parseNpm("npm", ["list", "--depth=0"], raw) as { dependencies: Array<{ name: string; version: string }> };
    expect(result.dependencies).toHaveLength(3);
    expect(result.dependencies[0]?.name).toBe("@eslint/js");
    expect(result.dependencies[0]?.version).toBe("10.0.1");
    expect(result.dependencies[1]?.name).toBe("typescript");
    expect(result.dependencies[1]?.version).toBe("5.9.3");
  });

  it("maxItems 초과 시 truncation", () => {
    const result = parseNpm("npm", ["list"], raw, { maxItems: 2 }) as { dependencies: unknown[] };
    expect(result.dependencies).toHaveLength(2);
  });

  it("버전 없이 name만 있는 경우 version 빈 문자열", () => {
    const noVer = "├── lodash";
    const result = parseNpm("npm", [], noVer) as { dependencies: Array<{ name: string; version: string }> };
    expect(result.dependencies[0]?.name).toBe("lodash");
    expect(result.dependencies[0]?.version).toBe("");
  });
});

describe("parseCargo()", () => {
  const raw = [
    "myproject v0.1.0 (/path/to/project)",
    "├── serde v1.0.0",
    "├── tokio v1.35.0",
    "└── reqwest v0.11.0",
  ].join("\n");

  it("cargo 파싱 불가 시 { lines } 폴백", () => {
    const result = parseCargo("cargo", [], "Compiling...\nerror") as { lines: string[] };
    expect(result.lines).toEqual(["Compiling...", "error"]);
  });

  it("cargo tree 출력을 파싱한다", () => {
    const result = parseCargo("cargo", ["tree"], raw) as { crates: Array<{ name: string; version: string }> };
    expect(result.crates.length).toBeGreaterThanOrEqual(2);
    const names = result.crates.map(c => c.name);
    expect(names).toContain("serde");
    expect(names).toContain("tokio");
  });

  it("cargo path 포함 행 파싱", () => {
    const withPath = "├── serde v1.0.0 (/path/to/serde)";
    const result = parseCargo("cargo", ["tree"], withPath) as { crates: Array<{ path?: string }> };
    expect(result.crates[0]?.path).toBe("/path/to/serde");
  });

  it("maxItems 초과 시 truncation", () => {
    const result = parseCargo("cargo", ["tree"], raw, { maxItems: 1 }) as { crates: unknown[] };
    expect(result.crates).toHaveLength(1);
  });
});
