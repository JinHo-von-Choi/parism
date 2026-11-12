/**
 * npx로 실행한 도구가 플래그를 그대로 받는지 실제 실행으로 확인한다.
 * npx는 `--` 없이 받은 `--noEmit` 같은 플래그를 npm 설정으로 읽어 대상 도구에 넘기지 않는다.
 * 그러면 `npx tsc --noEmit`이 .js 파일을 쓴다.
 *
 * 작성자: 최진호
 * 작성일: 2026-11-12
 */

import { describe, it, expect } from "vitest";
import { existsSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ParismEngine } from "../../src/facade/engine.js";
import { DEFAULT_CONFIG } from "../../src/config/loader.js";
import { createRegistry } from "../../src/parsers/index.js";

describe("npx 인자 전달", () => {
  it("npx tsc --noEmit은 파일을 쓰지 않는다", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "parism-npx-"));
    try {
      symlinkSync(path.resolve("node_modules"), path.join(dir, "node_modules"));
      writeFileSync(path.join(dir, "a.ts"), "export const x: number = 1;\n");
      const config = structuredClone(DEFAULT_CONFIG);
      config.guard.allowed_paths    = [dir];
      config.guard.profile          = "build";
      config.guard.allowed_commands = [...config.guard.allowed_commands, "npx"];
      config.guard.timeout_ms       = 60_000;
      const engine = new ParismEngine(config, createRegistry());
      const res = await engine.run("npx", { args: ["tsc", "--noEmit", "a.ts"], cwd: dir, contract_version: "next", machine_format: true });
      expect(res.ok, res.stderr.raw).toBe(true);
      expect(res.stderr.raw).not.toMatch(/Unknown cli config/);
      expect(existsSync(path.join(dir, "a.js"))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 90_000);
});
