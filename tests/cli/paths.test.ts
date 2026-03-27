import { describe, it, expect, afterEach } from "vitest";
import { parismHome, ensureParismDirs } from "../../src/cli/paths.js";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("parismHome()", () => {
  it("PARISM_HOME 환경변수가 설정되면 그 경로를 반환한다", () => {
    const orig = process.env.PARISM_HOME;
    process.env.PARISM_HOME = "/tmp/test-parism";
    expect(parismHome()).toBe("/tmp/test-parism");
    if (orig) process.env.PARISM_HOME = orig;
    else delete process.env.PARISM_HOME;
  });

  it("PARISM_HOME 미설정 시 ~/.parism을 반환한다", () => {
    const orig = process.env.PARISM_HOME;
    delete process.env.PARISM_HOME;
    expect(parismHome()).toMatch(/\.parism$/);
    if (orig) process.env.PARISM_HOME = orig;
  });
});

describe("ensureParismDirs()", () => {
  const testDir = join(tmpdir(), `parism-test-${Date.now()}`);

  afterEach(() => {
    if (existsSync(testDir)) rmSync(testDir, { recursive: true });
  });

  it("fixtures/, parsers/ 구조를 생성한다", () => {
    ensureParismDirs(testDir);
    expect(existsSync(join(testDir, "fixtures"))).toBe(true);
    expect(existsSync(join(testDir, "parsers"))).toBe(true);
  });

  it("이미 존재해도 에러 없이 동작한다", () => {
    ensureParismDirs(testDir);
    ensureParismDirs(testDir);
    expect(existsSync(join(testDir, "fixtures"))).toBe(true);
  });
});
