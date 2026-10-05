/**
 * compact 표현 변환이 값을 보존할 수 없을 때의 엔진 동작.
 * 손실이 있으면 압축하지 않고 원형 JSON 과 raw 를 모두 남기고 표준 failure 로 알린다.
 */

import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ParismEngine } from "../../src/facade/engine.js";
import { DEFAULT_CONFIG, type PrismConfig } from "../../src/config/loader.js";
import { createRegistry, ParserRegistry } from "../../src/parsers/index.js";

function withConfig(cwd: string): PrismConfig {
  const config = structuredClone(DEFAULT_CONFIG);
  config.guard.allowed_commands = ["echo"];
  config.guard.allowed_paths    = [cwd];
  return config;
}

describe("compact 표현 변환 실패", () => {
  it("순환 값이 있으면 압축하지 않고 raw 도 버리지 않는다", async () => {
    const dir  = mkdtempSync(path.join(tmpdir(), "parism-cmp-"));
    try {
      const registry = createRegistry();
      /** 실제 파서는 JSON 에서 값만 나오지만, 외부 팩과 SDK 사용자는 순환 값을 돌려줄 수 있다. */
      registry.register("echo", () => {
        const circular: Record<string, unknown> = { name: "a" };
        circular.self = circular;
        return { entries: [{ id: 1, payload: circular }] };
      });

      const engine = new ParismEngine(withConfig(dir), registry);
      const res    = await engine.run("echo", { args: ["x"], cwd: dir, format: "compact" });

      expect(res.failure?.reason).toBe("representation_not_lossless");
      expect(res.failure?.kind).toBe("parse");
      expect(res.failure?.message).toMatch(/circular|bigint/);

      /** 압축 표 형식이 아니라 원형 JSON 이 그대로 실려야 한다. */
      expect(res.stdout.parsed).toEqual({ entries: [{ id: 1, payload: expect.anything() }] });
      /** 압축이 실패해도 원문은 그대로 남는다. */
      expect(res.stdout.raw).toBe("x\n");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("BigInt 가 있어도 프로세스 예외가 아니라 실패 봉투가 된다", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "parism-cmp-"));
    try {
      const registry: ParserRegistry = createRegistry();
      registry.register("echo", () => ({ entries: [{ id: 1n }] }));
      const engine = new ParismEngine(withConfig(dir), registry);
      const res    = await engine.run("echo", { args: ["x"], cwd: dir, format: "compact" });

      expect(res.failure?.reason).toBe("representation_not_lossless");
      expect(res.failure?.message).toMatch(/bigint/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("값이 보존되면 평소대로 압축된다", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "parism-cmp-"));
    try {
      const registry = createRegistry();
      registry.register("echo", () => ({ entries: [{ name: "a" }, { name: "b" }] }));
      const engine = new ParismEngine(withConfig(dir), registry);
      const res    = await engine.run("echo", { args: ["x"], cwd: dir, format: "compact" });

      expect(res.failure).toBeUndefined();
      expect(res.stdout.parsed).toEqual({ entries: { schema: ["name"], rows: [["a"], ["b"]] } });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
