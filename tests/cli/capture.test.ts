import { describe, it, expect, afterEach } from "vitest";
import { captureCommand } from "../../src/cli/capture.js";
import { validateManifest } from "../../src/fixtures/manifest.js";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

/**
 * 캡처는 **정제된 매니페스트**를 낸다 — 계획서 8장 "정제본", "마스킹 때문에 바뀐 필드도 명시한다".
 *
 * 예전 형식(`command`/`args`/`exitCode` 최상위)은 버렸다. 판독자가 형식 버전을 볼 수 없었기 때문에
 * 조용히 깨졌다. 이제 `manifest_version` 으로 구분하고 잘못된 파일은 조용히 통과시키지 않는다.
 */
describe("captureCommand()", () => {
  const testDir = join(tmpdir(), `parism-capture-${Date.now()}`);

  afterEach(() => {
    if (existsSync(testDir)) rmSync(testDir, { recursive: true });
  });

  it("명령어 실행 결과를 검증 가능한 매니페스트로 저장한다", async () => {
    const result = await captureCommand("echo", ["hello world"], testDir);

    expect(result.exitCode).toBe(0);
    expect(result.fixturePath).toMatch(/\.json$/);
    expect(existsSync(result.fixturePath)).toBe(true);

    const fixture = JSON.parse(readFileSync(result.fixturePath, "utf-8"));
    const check   = validateManifest(fixture);
    expect(check.issues).toEqual([]);
    expect(check.ok).toBe(true);

    expect(fixture.tool.command).toBe("echo");
    expect(fixture.tool.args).toEqual(["hello world"]);
    expect(fixture.stdout).toContain("hello world");
    expect(fixture.exit.code).toBe(0);
    expect(fixture.content_hash).toMatch(/^[0-9a-f]{16}$/);
  });

  it("실패한 명령어도 fixture로 저장한다 (exit != 0)", async () => {
    const result = await captureCommand("ls", ["/nonexistent-path-xyz"], testDir);

    expect(result.exitCode).not.toBe(0);
    expect(existsSync(result.fixturePath)).toBe(true);

    const fixture = JSON.parse(readFileSync(result.fixturePath, "utf-8"));
    expect(fixture.exit.code).not.toBe(0);
    expect(fixture.stderr.length).toBeGreaterThan(0);
    expect(validateManifest(fixture).ok).toBe(true);
  });

  it("fixture 파일명에 명령어 이름과 타임스탬프가 포함된다", async () => {
    const result = await captureCommand("echo", ["test"], testDir);
    const basename = result.fixturePath.split("/").pop()!;
    expect(basename).toMatch(/^echo-\d{8}-\d{6}\.json$/);
  });

  it("캡처는 기대값을 만들지 않는다 — 사람이 검토해야 계약이 된다", async () => {
    const result = await captureCommand("echo", ["anything"], testDir);
    const fixture = JSON.parse(readFileSync(result.fixturePath, "utf-8"));
    /**
     * 캡처가 기대값을 채워 넣으면 '기계가 받아 적었으니 맞다' 는 거짓말이 된다.
     * 기대값은 사람이 보고 직접 넣는다.
     */
    expect(fixture.expected).toBeUndefined();
  });

  it("출력에 남은 시크릿과 홈 경로를 가리고, 무엇을 가렸는지 남긴다", async () => {
    const secret = "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345";
    const result = await captureCommand("echo", [secret, process.env.HOME ?? "/root"], testDir);
    const fixture = JSON.parse(readFileSync(result.fixturePath, "utf-8"));

    /** 원문이 그대로 남으면 안 된다 — 이 파일을 이슈에 붙이는 순간 그대로 퍼진다. */
    expect(fixture.stdout).not.toContain(secret);
    expect(fixture.tool.args.join(" ")).not.toContain(secret);
    expect(fixture.tool.args.some(a => a.startsWith("<redacted:"))).toBe(true);
    expect(fixture.tool.args_redacted).toBe(true);

    /** 가린 흔적이 없으면 '원래 없던 것인지 가린 것인지' 알 수 없다. */
    expect(result.redactions).toBeGreaterThan(0);
    expect(fixture.redactions.length).toBeGreaterThan(0);
    expect(fixture.redactions.every(r => r.count > 0)).toBe(true);
  });
});
