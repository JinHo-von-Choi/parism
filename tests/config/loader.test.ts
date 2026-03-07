import { describe, it, expect, vi } from "vitest";
import { unlink, writeFile } from "node:fs/promises";
import { loadConfig, DEFAULT_CONFIG } from "../../src/config/loader.js";

describe("loadConfig()", () => {
  it("기본 설정이 올바른 구조를 가진다", () => {
    const cfg = DEFAULT_CONFIG;

    expect(cfg.guard.allowed_commands).toBeInstanceOf(Array);
    expect(cfg.guard.allowed_commands.length).toBeGreaterThan(0);
    expect(cfg.guard.timeout_ms).toBeGreaterThan(0);
    expect(cfg.guard.block_patterns).toContain(";");
  });

  it("파일이 없으면 기본 설정을 반환한다", async () => {
    const cfg = await loadConfig("/tmp/__nonexistent_prism_config__.json");
    expect(cfg).toEqual(DEFAULT_CONFIG);
  });

  it("JSON 파싱 실패 시 기본 설정을 반환한다", async () => {
    const configPath = `/tmp/prism-config-invalid-${Date.now()}.json`;
    await writeFile(configPath, "{ invalid json }", "utf-8");
    try {
      const cfg = await loadConfig(configPath);
      expect(cfg).toEqual(DEFAULT_CONFIG);
    } finally {
      await unlink(configPath);
    }
  });

  it("DEFAULT_CONFIG에 default_page_size가 있다", () => {
    expect(DEFAULT_CONFIG.guard.default_page_size).toBe(100);
  });

  it("allowed_paths가 빈 배열로 명시되면 console.warn을 호출한다", async () => {
    const configPath = `/tmp/prism-config-empty-paths-${Date.now()}.json`;
    const body       = { guard: { allowed_paths: [] } };
    await writeFile(configPath, JSON.stringify(body), "utf-8");

    const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await loadConfig(configPath);
      expect(spy).toHaveBeenCalledOnce();
      expect(spy.mock.calls[0][0]).toContain("allowed_paths is empty");
    } finally {
      spy.mockRestore();
      await unlink(configPath);
    }
  });

  it("config 파일 없을 때 기본 allowed_paths는 process.cwd()이다", async () => {
    const cfg = await loadConfig("/tmp/__nonexistent_prism_config__.json");
    expect(cfg.guard.allowed_paths).toHaveLength(1);
    expect(cfg.guard.allowed_paths[0]).toBe(process.cwd());
  });

  it("allowed_paths가 설정되면 console.warn을 호출하지 않는다", async () => {
    const configPath = `/tmp/prism-config-warn-${Date.now()}.json`;
    const body       = { guard: { allowed_paths: ["/home"] } };
    await writeFile(configPath, JSON.stringify(body), "utf-8");

    const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await loadConfig(configPath);
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
      await unlink(configPath);
    }
  });

  it("부분 command_arg_restrictions override 시 기본 제한을 유지한다", async () => {
    const configPath = `/tmp/prism-config-${Date.now()}.json`;
    const body       = {
      guard: {
        command_arg_restrictions: {
          node: { blocked_flags: ["--eval"] },
        },
      },
    };

    await writeFile(configPath, JSON.stringify(body), "utf-8");

    try {
      const cfg = await loadConfig(configPath);
      expect(cfg.guard.command_arg_restrictions.node.blocked_flags).toEqual(["--eval"]);
      expect(cfg.guard.command_arg_restrictions.npx).toEqual(
        DEFAULT_CONFIG.guard.command_arg_restrictions.npx,
      );
    } finally {
      await unlink(configPath);
    }
  });
});
