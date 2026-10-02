import { describe, it, expect } from "vitest";
import { parseNpm }   from "../../src/parsers/packages/npm.js";
import { parseCargo } from "../../src/parsers/packages/cargo.js";

describe("parseNpm() ASCII 트리", () => {
  it("ASCII 트리(+--, `--)를 인식한다", () => {
    const raw = "a@1.0.0 /p\n+-- zod@3.25.76\n`-- commander@14.0.3\n";
    expect((parseNpm("npm", ["ls"], raw) as { dependencies: { name: string }[] }).dependencies.map(d => d.name)).toEqual(["zod", "commander"]);
  });
});

describe("parseNpm() 트리 해석", () => {
  type Deps = { dependencies: Array<{ name: string; version: string; depth: number; deduped?: true; problem?: string }> };
  const parse = (raw: string): Deps["dependencies"] => (parseNpm("npm", ["ls", "--all"], raw) as Deps).dependencies;

  it("UTF-8 트리의 부모 행(├─┬)과 마지막 자식 아래 들여쓰기를 깊이로 센다", () => {
    const rows = parse([
      "a@1.0.0 /p",
      "├─┬ cross-spawn@7.0.6",
      "│ ├── path-key@3.1.1",
      "│ └─┬ which@2.0.2",
      "│   └── isexe@2.0.0",
      "└── zod@3.25.76",
    ].join("\n"));
    expect(rows.map(r => [r.name, r.depth])).toEqual([["cross-spawn", 1], ["path-key", 2], ["which", 2], ["isexe", 3], ["zod", 1]]);
  });

  it("ASCII 트리도 같은 깊이 규칙을 따른다", () => {
    const rows = parse(["a@1 /p", "+-- cross-spawn@7.0.6", "| `-- which@2.0.2", "|   `-- isexe@2.0.0", "`-- zod@3.25.76"].join("\n"));
    expect(rows.map(r => [r.name, r.depth])).toEqual([["cross-spawn", 1], ["which", 2], ["isexe", 3], ["zod", 1]]);
  });

  it("deduped 표시를 이름과 버전에서 떼어 deduped 필드로 담는다", () => {
    const rows = parse("a@1 /p\n+-- ajv-formats@3.0.1\n| `-- ajv@8.18.0 deduped\n");
    expect(rows[1]).toEqual({ name: "ajv", version: "8.18.0", depth: 2, deduped: true });
  });

  it("UNMET 표시는 problem으로 담고 범위를 버전 자리에 둔다", () => {
    const rows = parse("a@1 /p\n+-- UNMET OPTIONAL DEPENDENCY @cfworker/json-schema@^4.1.1\n+-- left-pad@1.0.0 extraneous\n");
    expect(rows[0]).toEqual({ name: "@cfworker/json-schema", version: "^4.1.1", depth: 1, problem: "UNMET OPTIONAL DEPENDENCY" });
    expect(rows[1]).toMatchObject({ name: "left-pad", version: "1.0.0", problem: "extraneous" });
  });

  it("들여쓰기 한 칸이 4칸인 트리(pnpm 형식)는 첫 중첩 줄 너비로 깊이를 센다", () => {
    const rows = parse(["root", "├── a@1", "│   ├── b@2", "│   └── c@3", "└── d@4"].join("\n"));
    expect(rows.map(r => r.depth)).toEqual([1, 2, 2, 1]);
  });
});

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
