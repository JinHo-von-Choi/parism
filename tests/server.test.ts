import { describe, it, expect } from "vitest";
import { readFile }              from "node:fs/promises";
import { z }                     from "zod";
import { buildRunResult, buildPagedResult, PACKAGE_VERSION } from "../src/server.js";
import { DEFAULT_CONFIG }        from "../src/config/loader.js";
import { createRegistry }        from "../src/parsers/index.js";

const registry = createRegistry();

describe("buildRunResult()", () => {
  it("echo 명령을 실행하고 JSON 문자열을 반환한다", async () => {
    const result = await buildRunResult("echo", ["test-output"], process.cwd(), DEFAULT_CONFIG, registry);
    const parsed = JSON.parse(result);

    expect(parsed.ok).toBe(true);
    expect(parsed.stdout.raw.trim()).toBe("test-output");
  });

  it("차단된 명령은 ok=false와 guard_error를 반환한다", async () => {
    const result = await buildRunResult("rm", ["-rf", "/"], process.cwd(), DEFAULT_CONFIG, registry);
    const parsed = JSON.parse(result);

    expect(parsed.ok).toBe(false);
    expect(parsed.guard_error).toBeDefined();
    expect(parsed.guard_error.reason).toBe("command_not_allowed");
  });

  it("차단된 명령 봉투에 failure.kind=guard가 채워진다", async () => {
    const result = await buildRunResult("rm", ["-rf", "/"], process.cwd(), DEFAULT_CONFIG, registry);
    const parsed = JSON.parse(result);

    expect(parsed.failure?.kind).toBe("guard");
    expect(parsed.failure?.reason).toBe("command_not_allowed");
  });

  it("파서 미등록 명령은 ok=true이고 failure.reason=parser_not_found를 반환한다", async () => {
    // echo는 파서가 없고, 출력이 일반 텍스트이므로 native JSON도 아님 → parser_not_found
    const result = await buildRunResult("echo", ["plain text"], process.cwd(), DEFAULT_CONFIG, registry);
    const parsed = JSON.parse(result);

    expect(parsed.ok).toBe(true);
    expect(parsed.failure?.kind).toBe("parse");
    expect(parsed.failure?.reason).toBe("parser_not_found");
  });
});

describe("buildPagedResult()", () => {
  it("run_paged 도구가 page_info를 포함한 응답을 반환한다", async () => {
    const result = JSON.parse(
      await buildPagedResult("echo", ["hello"], process.cwd(), 0, 5, DEFAULT_CONFIG),
    );
    // echo는 단일 줄 출력이므로 total_lines=1, has_next=false
    expect(result.page_info).toBeDefined();
    expect(result.page_info.has_next).toBe(false);
    expect(result.page_info.total_lines).toBe(1);
    expect(result.ok).toBe(true);
  });

  it("차단된 명령은 ok=false와 guard_error를 반환한다", async () => {
    const result = JSON.parse(
      await buildPagedResult("rm", ["-rf", "/"], process.cwd(), 0, 5, DEFAULT_CONFIG),
    );
    expect(result.ok).toBe(false);
    expect(result.guard_error).toBeDefined();
  });

  it("stdout.parsed는 항상 null이다", async () => {
    const result = JSON.parse(
      await buildPagedResult("echo", ["hello"], process.cwd(), 0, 5, DEFAULT_CONFIG),
    );
    expect(result.stdout.parsed).toBeNull();
  });
});

describe("buildRunResult() with format", () => {
  it("format=compact이면 리스트 파서 결과가 schema+rows 형식이다", async () => {
    const result = JSON.parse(
      await buildRunResult("ls", ["-la"], process.cwd(), DEFAULT_CONFIG, registry, "compact"),
    );
    if (result.stdout.parsed && result.stdout.parsed.entries) {
      const entries = result.stdout.parsed.entries;
      expect(entries).toHaveProperty("schema");
      expect(entries).toHaveProperty("rows");
      expect(Array.isArray(entries.schema)).toBe(true);
      expect(Array.isArray(entries.rows)).toBe(true);
    }
  });

  it("format 미지정(기본값 json)이면 기존 형식 그대로다", async () => {
    const result = JSON.parse(
      await buildRunResult("echo", ["test"], process.cwd(), DEFAULT_CONFIG, registry),
    );
    expect(result.ok).toBe(true);
    expect(result.stdout.parsed).toBeNull();
  });

  it("format=json-no-raw이면 stdout.raw가 빈 문자열이다", async () => {
    const result = JSON.parse(
      await buildRunResult("ls", ["-la"], process.cwd(), DEFAULT_CONFIG, registry, "json-no-raw"),
    );
    expect(result.ok).toBe(true);
    expect(result.stdout.raw).toBe("");
    expect(result.stdout.parsed).not.toBeNull();
  });
});

describe("buildRunResult() native JSON passthrough", () => {
  it("stdout이 JSON이면 parsed에 파싱된 객체가 들어간다", async () => {
    const result = JSON.parse(
      await buildRunResult("echo", ['{"key":"value"}'], process.cwd(), DEFAULT_CONFIG, registry),
    );
    expect(result.ok).toBe(true);
    expect(result.stdout.parsed).toEqual({ key: "value" });
  });

  it("stdout이 일반 텍스트이면 parsed는 null이다", async () => {
    const result = JSON.parse(
      await buildRunResult("echo", ["plain text"], process.cwd(), DEFAULT_CONFIG, registry),
    );
    expect(result.stdout.parsed).toBeNull();
  });
});

describe("buildRunResult() with strict_schemas", () => {
  it("strict_schemas=true이고 schema_violation이 발생하면 failure.kind=parse, reason=schema_violation을 반환한다", async () => {
    const strictRegistry = createRegistry();
    // echo 출력에 대해 의도적으로 strict한 스키마를 등록 (숫자 필드 필수)
    strictRegistry.registerPack({
      name:  "echo",
      parse: (_raw, _args) => ({ message: "hello" }),   // count 필드 없음 → 스키마 위반
      schema: z.object({ count: z.number() }),           // count: number 필수
      fixtures: [],
    });

    const strictConfig = {
      ...DEFAULT_CONFIG,
      parsers: { strict_schemas: true },
    };

    const result = JSON.parse(
      await buildRunResult("echo", ["test"], process.cwd(), strictConfig, strictRegistry),
    );

    expect(result.ok).toBe(true);
    expect(result.failure?.kind).toBe("parse");
    expect(result.failure?.reason).toBe("schema_violation");
  });

  it("strict_schemas=false(기본값)이면 스키마 위반이 있어도 파서 출력을 그대로 반환한다", async () => {
    const defaultRegistry = createRegistry();
    defaultRegistry.registerPack({
      name:  "echo",
      parse: (_raw, _args) => ({ message: "hello" }),
      schema: z.object({ count: z.number() }),    // 위반이지만 검증 안 함
      fixtures: [],
    });

    const result = JSON.parse(
      await buildRunResult("echo", ["test"], process.cwd(), DEFAULT_CONFIG, defaultRegistry),
    );

    expect(result.ok).toBe(true);
    // strict_schemas=false → schema_violation 없음
    expect(result.failure?.reason).not.toBe("schema_violation");
    expect(result.stdout.parsed).toEqual({ message: "hello" });
  });
});

describe("output redaction (opt-in)", () => {
  // synthetic sk- token that is guaranteed to match the default pattern (>= 20 chars after prefix)
  const syntheticToken = "sk-abcdefghijklmnopqrstuvwxyz1234567890ABCD";
  const syntheticArg   = `API key: ${syntheticToken}`;

  // output_patterns를 undefined로 두어 기본 패턴 7개가 fallback으로 사용되도록 한다
  const redactionConfig = {
    ...DEFAULT_CONFIG,
    guard: {
      ...DEFAULT_CONFIG.guard,
      secrets: {
        env_patterns:             DEFAULT_CONFIG.guard.secrets!.env_patterns,
        output_redaction_enabled: true,
        // output_patterns는 의도적으로 생략 → undefined → 기본 패턴 사용
      },
    },
  };

  it("redaction disabled: stdout.raw에 토큰이 그대로 보존된다", async () => {
    const result = JSON.parse(
      await buildRunResult("echo", [syntheticArg], process.cwd(), DEFAULT_CONFIG, registry),
    );
    expect(result.stdout.raw).toContain(syntheticToken);
  });

  it("redaction enabled: stdout.raw에서 토큰이 [REDACTED]로 치환된다", async () => {
    const result = JSON.parse(
      await buildRunResult("echo", [syntheticArg], process.cwd(), redactionConfig, registry),
    );
    expect(result.stdout.raw).not.toContain(syntheticToken);
    expect(result.stdout.raw).toContain("[REDACTED]");
  });

  it("redaction enabled: stdout.parsed는 영향을 받지 않는다", async () => {
    // echo 출력은 native JSON이 아니므로 parsed=null — null은 redaction 대상 외
    const disabledResult = JSON.parse(
      await buildRunResult("echo", [syntheticArg], process.cwd(), DEFAULT_CONFIG, registry),
    );
    const enabledResult  = JSON.parse(
      await buildRunResult("echo", [syntheticArg], process.cwd(), redactionConfig, registry),
    );
    expect(enabledResult.stdout.parsed).toEqual(disabledResult.stdout.parsed);
  });

  it("redaction enabled: ok=true이고 failure는 리댁션 때문에 설정되지 않는다", async () => {
    const result = JSON.parse(
      await buildRunResult("echo", [syntheticArg], process.cwd(), redactionConfig, registry),
    );
    expect(result.ok).toBe(true);
    // failure가 있더라도 kind=parse(parser_not_found) — kind=guard/exec가 아님
    if (result.failure) {
      expect(result.failure.kind).toBe("parse");
    }
  });

  it("redaction enabled + output_patterns=[]: 패턴 없음 — 토큰이 그대로 보존된다", async () => {
    const noPatternConfig = {
      ...DEFAULT_CONFIG,
      guard: {
        ...DEFAULT_CONFIG.guard,
        secrets: {
          output_redaction_enabled: true,
          output_patterns:          [] as string[],
        },
      },
    };
    const result = JSON.parse(
      await buildRunResult("echo", [syntheticArg], process.cwd(), noPatternConfig, registry),
    );
    // output_patterns: [] → 빈 패턴 목록 → 치환 없음
    expect(result.stdout.raw).toContain(syntheticToken);
  });

  it("buildPagedResult: redaction enabled이면 paged raw에서도 토큰이 치환된다", async () => {
    const result = JSON.parse(
      await buildPagedResult("echo", [syntheticArg], process.cwd(), 0, 5, redactionConfig),
    );
    expect(result.stdout.raw).not.toContain(syntheticToken);
    expect(result.stdout.raw).toContain("[REDACTED]");
  });
});

describe("PACKAGE_VERSION", () => {
  it("package.json version과 일치한다", async () => {
    const pkgPath = new URL("../package.json", import.meta.url);
    const raw     = await readFile(pkgPath, "utf-8");
    const pkg     = JSON.parse(raw) as { version: string };

    expect(PACKAGE_VERSION).toBe(pkg.version);
  });
});
