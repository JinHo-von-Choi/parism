import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadConfig, DEFAULT_CONFIG } from "../../src/config/loader.js";
import { ParismEngine } from "../../src/facade/engine.js";
import { createRegistry } from "../../src/parsers/index.js";
import { DEFAULT_OUTPUT_REDACT_PATTERNS } from "../../src/engine/redactor.js";

/** 설정 로더를 실제로 거치는 경로만 이 시험이 다룬다. */
const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function configWithSecrets(secrets: Record<string, unknown>) {
  const dir  = mkdtempSync(path.join(tmpdir(), "parism-mask-"));
  dirs.push(dir);
  const file = path.join(dir, "prism.config.json");
  writeFileSync(file, JSON.stringify({
    guard: { allowed_commands: ["echo"], allowed_paths: [process.cwd()], secrets },
  }));
  return file;
}

/** 기본 패턴이 잡아야 하는 합성 비밀. 전부 실제 서비스/providers 형식이다. */
const CANARIES: Array<[string, string]> = [
  ["OpenAI/Anthropic", "sk-" + "a".repeat(32)],
  ["GitHub PAT", "ghp_" + "b".repeat(36)],
  ["AWS access key", "AKIA" + "C".repeat(16)],
  ["Slack", "xoxb-" + "d".repeat(20)],
  ["GitLab PAT", "glpat-" + "e".repeat(24)],
];

describe("리댁션 패턴의 기본값", () => {
  it("기본 설정은 output_patterns 를 두지 않는다 — 생략과 빈 배열을 구별해야 한다", () => {
    /** [] 를 기본값으로 두면 리댁션을 켜도 아무것도 가려지지 않는다. */
    expect(DEFAULT_CONFIG.guard.secrets).not.toHaveProperty("output_patterns");
  });

  it("패턴을 생략하면 로더가 undefined 를 주고 엔진이 기본 패턴을 쓴다", async () => {
    const config = await loadConfig(configWithSecrets({ output_redaction_enabled: true }));
    expect(config.guard.secrets?.output_patterns).toBeUndefined();

    const engine = new ParismEngine(config, createRegistry());
    for (const [name, canary] of CANARIES) {
      const res = await engine.run("echo", { args: [canary], cwd: process.cwd() });
      expect(res.stdout.raw, name).not.toContain(canary);
      expect(res.stdout.raw, name).toContain("[REDACTED]");
    }
  });

  it("빈 배열을 명시하면 의도적 비활화로 보고 치환하지 않는다", async () => {
    const config = await loadConfig(configWithSecrets({
      output_redaction_enabled: true, output_patterns: [],
    }));
    expect(config.guard.secrets?.output_patterns).toEqual([]);

    const engine = new ParismEngine(config, createRegistry());
    for (const [name, canary] of CANARIES) {
      const res = await engine.run("echo", { args: [canary], cwd: process.cwd() });
      expect(res.stdout.raw, name).toContain(canary);
    }
  });

  it("사용자 패턴만 지정하면 그 패턴만 쓴다(기본 패턴과 병합하지 않는다)", async () => {
    const config = await loadConfig(configWithSecrets({
      output_redaction_enabled: true, output_patterns: ["MYTOKEN-[0-9]+"],
    }));
    expect(config.guard.secrets?.output_patterns).toEqual(["MYTOKEN-[0-9]+"]);

    const engine = new ParismEngine(config, createRegistry());
    const res = await engine.run("echo", { args: ["MYTOKEN-42"], cwd: process.cwd() });
    expect(res.stdout.raw).toContain("[REDACTED]");
  });

  it("output_redaction_enabled 하나만 켜도 env_patterns 기본값이 남는다", async () => {
    /** secrets 를 통째로 갈아끼우면 환경변수 시크릿 제거 기본값이 조용히 사라진다. */
    const config = await loadConfig(configWithSecrets({ output_redaction_enabled: true }));
    expect(config.guard.secrets?.env_patterns).toBeInstanceOf(Array);
    expect(config.guard.secrets?.env_patterns?.length).toBeGreaterThan(0);
  });

  it("기본 패턴 목록 자체는 비어 있지 않다", () => {
    expect(DEFAULT_OUTPUT_REDACT_PATTERNS.length).toBeGreaterThan(0);
  });
});
