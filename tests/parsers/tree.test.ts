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

  it("확장자 없는 파일과 점이 있는 디렉터리를 들여쓰기로 구분한다", () => {
    const r = [
      ".",
      "├── Makefile",
      "├── v1.2",
      "│   └── LICENSE",
      "└── src",
      "    └── a.ts",
      "",
      "2 directories, 3 files",
    ].join("\n");
    const root = parseTree("tree", [], r).root;
    const byName = Object.fromEntries(root.children.map(c => [c.name, c.type]));
    expect(byName).toEqual({ Makefile: "file", "v1.2": "directory", src: "directory" });
    expect(root.children[2]!.children[0]!.name).toBe("a.ts");
  });

  it("ASCII 연결자를 인식한다", () => {
    const r = ".\n|-- d\n|   `-- f\n`-- g\n\n1 directory, 2 files";
    const root = parseTree("tree", [], r).root;
    expect(root.children.map(c => c.name)).toEqual(["d", "g"]);
    expect(root.children[0]!.children[0]!.name).toBe("f");
  });
});
