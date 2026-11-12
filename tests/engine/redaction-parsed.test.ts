/**
 * 파싱 결과 리댁션 시험. 출력 형식과 관계없이 응답과 보관 결과에 비밀이 남지 않아야 한다.
 *
 * 작성자: 최진호
 * 작성일: 2026-11-12
 */

import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DEFAULT_OUTPUT_REDACT_PATTERNS, redact, redactParsedValue } from "../../src/engine/redactor.js";
import { secretAssignmentRanges } from "../../src/engine/secret-assignment.js";
import { ParismEngine } from "../../src/facade/engine.js";
import { DEFAULT_CONFIG } from "../../src/config/loader.js";
import { createRegistry } from "../../src/parsers/index.js";

const SECRET = "ghp_" + "S".repeat(36);

describe("secretAssignmentRanges", () => {
  it("이름은 남기고 값만 가리킨다", async () => {
    expect(await redact("DB_PASSWORD=hunter22 HOME=/x", DEFAULT_OUTPUT_REDACT_PATTERNS)).toBe("DB_PASSWORD=[REDACTED] HOME=/x");
    expect(await redact(`"api_key": "abcdef"`, DEFAULT_OUTPUT_REDACT_PATTERNS)).toBe(`"api_key": "[REDACTED]"`);
    expect(await redact("token: xyz123", DEFAULT_OUTPUT_REDACT_PATTERNS)).toBe("token: [REDACTED]");
  });

  it("URL과 짧은 값, 대입이 아닌 낱말은 건드리지 않는다", () => {
    expect(secretAssignmentRanges("https://token.example.com/a")).toEqual([]);
    expect(secretAssignmentRanges("tokens: 5")).toEqual([]);
    expect(secretAssignmentRanges("fix token handling")).toEqual([]);
  });

  it("긴 식별자에서도 선형 시간이다", () => {
    const text = "password".repeat(20_000) + "x".repeat(200_000);
    const t = performance.now();
    secretAssignmentRanges(text);
    expect(performance.now() - t).toBeLessThan(500);
  });
});

describe("redactParsedValue", () => {
  it("문자열 값과 키, 이름이 비밀을 뜻하는 필드의 값을 가린다", async () => {
    const out = await redactParsedValue({
      vars: { DB_PASSWORD: "plain-value", HOME: "/home/x", URL: "redis://:pw123@host" },
      rows: [{ name: "API_TOKEN", value: "zzz" }, { name: "PATH", value: "/bin" }, { msg: `use ${SECRET} now` }],
      [SECRET]: 1,
    }, DEFAULT_OUTPUT_REDACT_PATTERNS);
    const json = JSON.stringify(out.value);
    expect(json).not.toContain("plain-value");
    expect(json).not.toContain("pw123");
    expect(json).not.toContain("zzz");
    expect(json).not.toContain(SECRET);
    expect(json).toContain("/home/x");
    expect(json).toContain("/bin");
    expect(out.count).toBeGreaterThanOrEqual(5);
  });

  it("가린 것이 없으면 같은 참조를 돌려준다", async () => {
    const value = { a: ["x", "y"], b: 1 };
    expect((await redactParsedValue(value, DEFAULT_OUTPUT_REDACT_PATTERNS)).value).toBe(value);
  });

  it("두 필드에 걸친 비밀은 두 필드 모두 가린다", async () => {
    const out = await redactParsedValue(["Authorization: Bearer", "abc.def"], DEFAULT_OUTPUT_REDACT_PATTERNS);
    expect(out.value).toEqual(["Authorization: [REDACTED]", "[REDACTED]"]);
  });
});

describe("엔진: 리댁션은 모든 출력 경로의 파싱 결과에 적용된다", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "parism-redact-"));
  writeFileSync(path.join(dir, "secrets.txt"), [`token=${SECRET}`, "AKIAABCDEFGHIJKLMNOP", "plain line", ""].join("\n"));
  const config = structuredClone(DEFAULT_CONFIG);
  config.guard.allowed_paths = [dir];
  config.guard.secrets = { ...config.guard.secrets, output_redaction_enabled: true };
  const engine = new ParismEngine(config, createRegistry());
  const leaks  = (value: unknown) => /S{36}|AKIAABCDEFGHIJKLMNOP/.test(JSON.stringify(value));

  it.each([
    ["json", {}], ["compact", { format: "compact" as const }], ["json-no-raw", { format: "json-no-raw" as const }],
    ["include_raw", { include_raw: true }], ["select", { select: ["line"] }],
  ])("%s", async (_name, opts) => {
    const res = await engine.run("cat", { args: [path.join(dir, "secrets.txt")], cwd: dir, ...opts });
    expect(res.ok).toBe(true);
    expect(leaks(res)).toBe(false);
  });

  it("파이프 행 모드와 글자 모드", async () => {
    expect(leaks(await engine.run("", { command: `cat ${path.join(dir, "secrets.txt")} | grep -v plain`, cwd: dir }))).toBe(false);
    expect(leaks(await engine.run("", { command: `cat ${path.join(dir, "secrets.txt")} | cut -c1-200`, cwd: dir }))).toBe(false);
  });

  it("보관 결과를 다시 질의해도 가린 값이다", async () => {
    const res = await engine.run("cat", { args: [path.join(dir, "secrets.txt")], cwd: dir, contract_version: "next", retain: true });
    const id  = res.review!.result_id;
    expect(leaks(engine.queryResult(id, {}))).toBe(false);
    expect(leaks(engine.explainResult(id, ""))).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });
});
