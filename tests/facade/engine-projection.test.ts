/**
 * ParismEngine.run의 투영과 필터 인자 시험.
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 */

import { describe, it, expect, beforeAll } from "vitest";
import { mkdtempSync, writeFileSync }      from "node:fs";
import { tmpdir }                          from "node:os";
import path                                from "node:path";
import { ParismEngine }                    from "../../src/facade/engine.js";
import { DEFAULT_CONFIG, type PrismConfig } from "../../src/config/loader.js";
import { createRegistry }                  from "../../src/parsers/index.js";

/** 크기가 i+1 바이트인 파일 f000..f{n-1}을 담은 임시 디렉터리 */
function makeDir(n: number): string {
  const dir = mkdtempSync(path.join(tmpdir(), "parism-proj-"));
  for (let i = 0; i < n; i++) writeFileSync(path.join(dir, `f${String(i).padStart(3, "0")}`), "x".repeat(i + 1));
  return dir;
}

function engineFor(dir: string, patch: (c: PrismConfig) => void = () => {}): ParismEngine {
  const config = structuredClone(DEFAULT_CONFIG);
  config.guard.allowed_paths = [dir];
  patch(config);
  return new ParismEngine(config, createRegistry());
}

describe("ParismEngine.run() 투영", () => {
  let dir: string;
  beforeAll(() => { dir = makeDir(60); });

  it("select와 limit은 parsed 배열을 줄이고 _summary를 남기며 raw를 비운다", async () => {
    const result = await engineFor(dir).run("ls", { args: ["-l", dir], cwd: dir, select: ["name", "size_bytes"], limit: 5 });

    expect(result.failure).toBeUndefined();
    expect(result.stdout.raw).toBe("");
    const parsed = result.stdout.parsed as { entries: Record<string, unknown>[]; _summary: unknown };
    expect(parsed.entries).toHaveLength(5);
    expect(Object.keys(parsed.entries[0]!)).toEqual(["name", "size_bytes"]);
    expect(parsed._summary).toEqual({ total: 60, matched: 60, shown: 5 });
  });

  it("where와 sort_by로 고르고 정렬한다", async () => {
    const result = await engineFor(dir).run("ls", {
      args: ["-l", dir], cwd: dir,
      where:   [{ field: "size_bytes", op: "gt", value: 58 }],
      sort_by: { field: "size_bytes", order: "desc" },
      select:  ["name"],
    });
    const parsed = result.stdout.parsed as { entries: { name: string }[]; _summary: unknown };
    expect(parsed.entries.map(e => e.name)).toEqual(["f059", "f058"]);
    expect(parsed._summary).toEqual({ total: 60, matched: 2, shown: 2 });
  });

  it("compact 형식과 함께 쓰면 선택한 열만 남는다", async () => {
    const result = await engineFor(dir).run("ls", { args: ["-l", dir], cwd: dir, format: "compact", select: ["name"], limit: 2 });
    const parsed = result.stdout.parsed as { entries: { schema: string[]; rows: unknown[][] } };
    expect(parsed.entries).toEqual({ schema: ["name"], rows: [["f000"], ["f001"]] });
  });

  it("적응형 형식 임계값은 줄어든 행 수를 본다", async () => {
    const engine = engineFor(dir, c => { c.parsers = { adaptive_format_threshold: { compact: 50, json_no_raw: 200 } }; });
    const full   = await engine.run("ls", { args: ["-l", dir], cwd: dir });
    const small  = await engine.run("ls", { args: ["-l", dir], cwd: dir, limit: 10 });
    expect((full.stdout.parsed as { entries: unknown }).entries).toHaveProperty("schema");
    expect(Array.isArray((small.stdout.parsed as { entries: unknown }).entries)).toBe(true);
  });

  it("투영할 때는 max_items 상한 전 전체 행을 보고 보이는 행만 상한으로 자른다", async () => {
    const engine = engineFor(dir, c => { c.guard.max_items = 10; });
    const result = await engine.run("ls", { args: ["-l", dir], cwd: dir, sort_by: { field: "size_bytes", order: "desc" }, select: ["name"] });
    const parsed = result.stdout.parsed as { entries: { name: string }[]; _summary: unknown };
    expect(parsed.entries[0]!.name).toBe("f059");
    expect(parsed._summary).toEqual({ total: 60, matched: 60, shown: 10, truncated: true });
  });

  it("알 수 없는 필드는 failure.kind=config이고 raw를 남긴다", async () => {
    const result = await engineFor(dir).run("ls", { args: ["-l", dir], cwd: dir, format: "json-no-raw", select: ["nam"] });
    expect(result.failure?.kind).toBe("config");
    expect(result.failure?.reason).toBe("unknown_field");
    expect(result.failure?.message).toContain("size_bytes");
    expect(result.stdout.parsed).toBeNull();
    expect(result.stdout.raw).toContain("f000");
  });

  it("문법에 맞지 않는 인자는 실행하지 않고 config 실패를 돌려준다", async () => {
    const result = await engineFor(dir).run("ls", {
      args: ["-l", dir], cwd: dir,
      where: [{ field: "name", op: "like", value: "f" }] as never,
    });
    expect(result.ok).toBe(false);
    expect(result.exitCode).toBe(-1);
    expect(result.failure?.kind).toBe("config");
    expect(result.failure?.reason).toBe("invalid_projection");
    expect(result.stdout.raw).toBe("");
  });

  it("guard 검사는 인자 검사보다 먼저다", async () => {
    const result = await engineFor(dir).run("rm", { args: ["x"], cwd: dir, limit: -1 });
    expect(result.failure?.kind).toBe("guard");
  });

  it("파싱 결과가 없으면 투영하지 않고 기존 실패를 둔다", async () => {
    const result = await engineFor(dir).run("echo", { args: ["hello"], cwd: dir, limit: 1 });
    expect(result.failure?.reason).toBe("parser_not_found");
    expect(result.stdout.raw.trim()).toBe("hello");
  });
});
