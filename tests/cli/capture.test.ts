import { describe, it, expect, afterEach } from "vitest";
import { captureCommand } from "../../src/cli/capture.js";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("captureCommand()", () => {
  const testDir = join(tmpdir(), `parism-capture-${Date.now()}`);

  afterEach(() => {
    if (existsSync(testDir)) rmSync(testDir, { recursive: true });
  });

  it("명령어 실행 결과를 fixture 파일로 저장한다", async () => {
    const result = await captureCommand("echo", ["hello world"], testDir);

    expect(result.exitCode).toBe(0);
    expect(result.fixturePath).toMatch(/\.json$/);
    expect(existsSync(result.fixturePath)).toBe(true);

    const fixture = JSON.parse(readFileSync(result.fixturePath, "utf-8"));
    expect(fixture.command).toBe("echo");
    expect(fixture.args).toEqual(["hello world"]);
    expect(fixture.stdout).toContain("hello world");
    expect(fixture.exitCode).toBe(0);
  });

  it("실패한 명령어도 fixture로 저장한다 (exitCode != 0)", async () => {
    const result = await captureCommand("ls", ["/nonexistent-path-xyz"], testDir);

    expect(result.exitCode).not.toBe(0);
    expect(existsSync(result.fixturePath)).toBe(true);

    const fixture = JSON.parse(readFileSync(result.fixturePath, "utf-8"));
    expect(fixture.exitCode).not.toBe(0);
    expect(fixture.stderr.length).toBeGreaterThan(0);
  });

  it("fixture 파일명에 명령어 이름과 타임스탬프가 포함된다", async () => {
    const result = await captureCommand("echo", ["test"], testDir);
    const basename = result.fixturePath.split("/").pop()!;
    expect(basename).toMatch(/^echo-\d{8}-\d{6}\.json$/);
  });
});
