import { describe, it, expect } from "vitest";
import { parseTree } from "../../src/parsers/fs/tree.js";

describe("parseTree()", () => {
  const raw = [
    "src",
    "├── engine",
    "│   ├── executor.ts",
    "│   └── guard.ts",
    "└── index.ts",
    "",
    "1 directory, 3 files",
  ].join("\n");

  it("디렉토리 구조를 파싱한다", () => {
    const result = parseTree("tree", [], raw);
    expect(result.root.name).toBe("src");
    expect(result.files).toBe(3);
    expect(result.directories).toBe(1);
    expect(result.root.children).toHaveLength(2); // engine + index.ts
  });
});
