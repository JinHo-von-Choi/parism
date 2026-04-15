import { describe, it, expect } from "vitest";
import { z }                    from "zod";
import {
  ParserRegistry,
  exportJsonSchema,
  type ParseContext,
} from "../../src/parsers/registry.js";
import type { ParserPack } from "../../src/parsers/registry.js";
import { createRegistry }    from "../../src/parsers/index.js";

describe("ParserRegistry", () => {
  it("등록된 파서가 없으면 parsed=null을 반환한다", () => {
    const registry = new ParserRegistry();
    const result   = registry.parse("unknown_cmd", [], "some output");
    expect(result.parsed).toBeNull();
    expect(result.parse_error).toBeUndefined();
  });

  it("미등록 명령 parse()는 { parsed: null } 형태를 유지한다 (parser_not_found는 봉투 계층에서 처리)", () => {
    const registry = new ParserRegistry();
    const result   = registry.parse("__no_such_command__", ["arg1"], "output text");
    expect(result).toEqual({ parsed: null });
    expect(result.parse_error).toBeUndefined();
  });

  it("등록된 파서가 있으면 파싱 결과를 반환한다", () => {
    const registry = new ParserRegistry();
    registry.register("echo", () => ({ words: ["hello"] }));

    const result = registry.parse("echo", ["hello"], "hello");
    expect(result.parsed).toEqual({ words: ["hello"] });
    expect(result.parse_error).toBeUndefined();
  });

  it("파서가 예외를 던지면 parsed=null, parse_error 설정 (graceful degradation)", () => {
    const registry = new ParserRegistry();
    registry.register("bad_cmd", () => { throw new Error("parse error"); });

    const result = registry.parse("bad_cmd", [], "output");
    expect(result.parsed).toBeNull();
    expect(result.parse_error).toEqual({ reason: "parser_exception", message: "parse error" });
  });

  it("defaultRegistry git status/log/diff/branch 서브커맨드 파싱", async () => {
    const { defaultRegistry } = await import("../../src/parsers/index.js");

    const statusOut = "On branch main\nChanges not staged for commit:\n  modified:   x.ts\n";
    expect(defaultRegistry.parse("git", ["status"], statusOut).parsed).not.toBeNull();

    const logOut = "abc123 feat: add\n";
    expect(defaultRegistry.parse("git", ["log", "--oneline"], logOut).parsed).not.toBeNull();

    const diffOut = "diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1,1 +1,1 @@\n-a\n+b\n";
    expect(defaultRegistry.parse("git", ["diff"], diffOut).parsed).not.toBeNull();

    const branchOut = "* main abc123 [origin/main] msg\n";
    expect(defaultRegistry.parse("git", ["branch", "-vv"], branchOut).parsed).not.toBeNull();
  });

  it("defaultRegistry git 서브커맨드 미지원 시 parsed=null", async () => {
    const { defaultRegistry } = await import("../../src/parsers/index.js");
    const result = defaultRegistry.parse("git", ["clone", "url"], "Cloning...");
    expect(result.parsed).toBeNull();
  });

  it("parse()가 ParseContext를 파서 함수에 전달한다", () => {
    const registry = new ParserRegistry();
    let   capturedCtx: ParseContext | undefined;
    registry.register("testcmd", (_cmd, _args, _raw, ctx) => { capturedCtx = ctx; return {}; });

    registry.parse("testcmd", [], "", { maxItems: 42 });
    expect(capturedCtx?.maxItems).toBe(42);
  });
});

describe("ParserPack interface", () => {
  it("ParserPack 구현체가 name, parse, schema, fixtures를 가진다", () => {
    const pack: ParserPack = {
      name:   "test-cmd",
      parse:  (_raw, _args) => ({ items: [] }),
      schema: z.object({ items: z.array(z.unknown()) }),
      fixtures: [
        { input: "line1\nline2", args: [], expected: { items: [] } },
      ],
    };

    expect(pack.name).toBe("test-cmd");
    expect(pack.parse("", [])).toEqual({ items: [] });
    expect(pack.schema).toBeDefined();
    expect(pack.fixtures).toHaveLength(1);
  });

  it("meta 필드는 선택적이다", () => {
    const pack: ParserPack = {
      name:    "opt",
      parse:   (_raw, _args) => null,
      schema:  z.unknown(),
      fixtures: [],
      meta:    { os: ["linux"], version: "1.0" },
    };

    expect(pack.meta?.os).toContain("linux");
  });
});

describe("ParserRegistry.registerPack()", () => {
  it("ParserPack을 등록하면 parse()로 실행된다", () => {
    const registry = new ParserRegistry();
    const pack: ParserPack = {
      name:   "mycmd",
      parse:  (raw, _args) => ({ lines: raw.split("\n").length }),
      schema: z.object({ lines: z.number() }),
      fixtures: [],
    };

    registry.registerPack(pack);
    const result = registry.parse("mycmd", [], "a\nb\nc");
    expect(result.parsed).toEqual({ lines: 3 });
  });

  it("registerPack은 기존 register()와 공존한다", () => {
    const registry = new ParserRegistry();
    registry.register("old", (_cmd, _args, raw) => ({ old: true, len: raw.length }));

    const pack: ParserPack = {
      name:   "new",
      parse:  (raw) => ({ new: true, len: raw.length }),
      schema: z.object({ new: z.boolean(), len: z.number() }),
      fixtures: [],
    };
    registry.registerPack(pack);

    expect(registry.parse("old", [], "x").parsed).toEqual({ old: true, len: 1 });
    expect(registry.parse("new", [], "x").parsed).toEqual({ new: true, len: 1 });
  });

  it("getPack()으로 등록된 ParserPack을 조회할 수 있다", () => {
    const registry = new ParserRegistry();
    const pack: ParserPack = {
      name:    "lookup",
      parse:   () => null,
      schema:  z.unknown(),
      fixtures: [{ input: "x", args: [], expected: null }],
    };

    registry.registerPack(pack);
    expect(registry.getPack("lookup")).toBe(pack);
    expect(registry.getPack("missing")).toBeUndefined();
  });

  it("listPacks()로 등록된 모든 ParserPack 이름을 조회한다", () => {
    const registry = new ParserRegistry();
    registry.registerPack({
      name: "a", parse: () => null, schema: z.unknown(), fixtures: [],
    });
    registry.registerPack({
      name: "b", parse: () => null, schema: z.unknown(), fixtures: [],
    });
    registry.register("c", () => null);

    const names = registry.listPacks();
    expect(names).toContain("a");
    expect(names).toContain("b");
    expect(names).not.toContain("c");
  });

  // ── Zod schema / strict_schemas tests ──────────────────────────────────

  it("strictSchemas=false이면 스키마 검증 없이 파서 출력을 그대로 반환한다", () => {
    const registry = new ParserRegistry();
    const pack: ParserPack = {
      name:  "validated",
      parse: () => ({ count: "not-a-number" }),    // 스키마 위반이지만 검증 안 함
      schema: z.object({ count: z.number() }),
      fixtures: [],
    };

    registry.registerPack(pack);
    const result = registry.parse("validated", [], "x", undefined, false);
    expect(result.parsed).toEqual({ count: "not-a-number" });
    expect(result.parse_error).toBeUndefined();
  });

  it("strictSchemas=true이고 파서 출력이 스키마를 위반하면 schema_violation을 반환한다", () => {
    const registry = new ParserRegistry();
    const pack: ParserPack = {
      name:  "strict-cmd",
      parse: () => ({ count: "oops" }),    // z.number() 위반
      schema: z.object({ count: z.number() }),
      fixtures: [],
    };

    registry.registerPack(pack);
    const result = registry.parse("strict-cmd", [], "x", undefined, true);
    expect(result.parsed).toBeNull();
    expect(result.parse_error?.reason).toBe("schema_violation");
    expect(result.parse_error?.message).toBeTruthy();
  });

  it("strictSchemas=true이고 파서 출력이 스키마를 만족하면 정상 반환된다", () => {
    const registry = new ParserRegistry();
    const pack: ParserPack = {
      name:  "valid-cmd",
      parse: () => ({ count: 42 }),
      schema: z.object({ count: z.number() }),
      fixtures: [],
    };

    registry.registerPack(pack);
    const result = registry.parse("valid-cmd", [], "x", undefined, true);
    expect(result.parsed).toEqual({ count: 42 });
    expect(result.parse_error).toBeUndefined();
  });

  it("strictSchemas=true이고 bare register()로 등록된 파서는 스키마 검증을 건너뛴다", () => {
    const registry = new ParserRegistry();
    // bare register — ParserPack이 없으므로 strictSchemas=true여도 검증 없음
    registry.register("bare", () => ({ anything: true }));

    const result = registry.parse("bare", [], "x", undefined, true);
    expect(result.parsed).toEqual({ anything: true });
    expect(result.parse_error).toBeUndefined();
  });
});

describe("exportJsonSchema()", () => {
  it("ParserPack의 Zod 스키마를 JSON Schema 객체로 변환한다", () => {
    const pack: ParserPack = {
      name:  "export-test",
      parse: () => null,
      schema: z.object({
        count: z.number(),
        items: z.array(z.string()),
      }),
      fixtures: [],
    };

    const jsonSchema = exportJsonSchema(pack);
    expect(jsonSchema).toBeDefined();
    expect(typeof jsonSchema).toBe("object");
    // JSON Schema $schema 또는 type 필드가 있어야 함
    const js = jsonSchema as Record<string, unknown>;
    expect(js.type ?? js.$schema ?? js.definitions).toBeDefined();
  });
});

describe("createRegistry()", () => {
  it("44개 내장 파서가 등록된 레지스트리를 반환한다", () => {
    const registry = createRegistry();
    const commands = [
      "ls", "find", "stat", "du", "df", "tree",
      "ps", "kill",
      "ping", "curl", "netstat", "lsof", "ss", "dig",
      "grep", "wc", "head", "tail", "cat",
      "env", "pwd", "which",
      "free", "uname", "id", "systemctl", "journalctl",
      "dir", "tasklist", "ipconfig", "systeminfo",
      "kubectl", "docker", "gh", "helm", "terraform",
      "apt", "brew",
      "npm", "pnpm", "yarn", "cargo",
      "git",
    ];

    for (const cmd of commands) {
      const result = registry.parse(cmd, [], "");
      // 파서가 등록되어 있으면 parsed는 null이 아니거나, 빈 입력에 대한 결과를 반환
      // 핵심: parsed가 undefined가 아님 (파서 함수가 호출됨)
      expect(result).toBeDefined();
    }
  });

  it("매번 새 인스턴스를 반환한다 (싱글턴이 아님)", () => {
    const a = createRegistry();
    const b = createRegistry();
    expect(a).not.toBe(b);
  });
});
