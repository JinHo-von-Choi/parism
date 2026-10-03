import { describe, it, expect, afterEach } from "vitest";
import { parismHome, ensureParismDirs, isValidPackName } from "../../src/cli/paths.js";
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

describe("isValidPackName()", () => {
  it("영문자나 숫자로 시작하고 영문자, 숫자, '.', '_', '-'로 된 64자 이하 이름을 받는다", () => {
    for (const name of ["myparser", "my-parser", "a.b_c", "A1", "x", "a".repeat(64)]) {
      expect(isValidPackName(name), name).toBe(true);
    }
  });

  it("빈 이름, 점 이름, 경로 구분자, 앞의 점이나 대시나 밑줄, 64자 초과, 공백을 거부한다", () => {
    for (const name of ["", ".", "..", "__proto__", "a/b", "a\\b", ".hidden", "-dash", "_under", "a".repeat(65), "a b", "a\n"]) {
      expect(isValidPackName(name), JSON.stringify(name)).toBe(false);
    }
  });
});
