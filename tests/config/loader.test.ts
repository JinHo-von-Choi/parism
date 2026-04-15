import { describe, it, expect, vi, afterEach } from "vitest";
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

describe("loadConfig() — guard.secrets 마이그레이션 shim", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("레거시 전용: env_secret_patterns만 있을 때 secrets.env_patterns에 복사하고 경고를 출력한다", async () => {
    const configPath = `/tmp/prism-config-legacy-only-${Date.now()}.json`;
    const patterns   = ["MY_TOKEN", "MY_SECRET"];
    const body       = { guard: { env_secret_patterns: patterns } };
    await writeFile(configPath, JSON.stringify(body), "utf-8");

    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      const cfg = await loadConfig(configPath);

      expect(stderrSpy).toHaveBeenCalledOnce();
      expect(String(stderrSpy.mock.calls[0][0])).toContain(
        "guard.env_secret_patterns is deprecated",
      );
      expect(cfg.guard.secrets?.env_patterns).toEqual(patterns);
      expect(cfg.guard.env_secret_patterns).toEqual(patterns);
    } finally {
      await unlink(configPath);
    }
  });

  it("신규 전용: secrets.env_patterns만 있을 때 경고 없이 정상 동작한다", async () => {
    const configPath = `/tmp/prism-config-new-only-${Date.now()}.json`;
    const patterns   = ["NEW_TOKEN", "NEW_SECRET"];
    const body       = { guard: { secrets: { env_patterns: patterns } } };
    await writeFile(configPath, JSON.stringify(body), "utf-8");

    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      const cfg = await loadConfig(configPath);

      expect(stderrSpy).not.toHaveBeenCalled();
      expect(cfg.guard.secrets?.env_patterns).toEqual(patterns);
      expect(cfg.guard.env_secret_patterns).toEqual(patterns);
    } finally {
      await unlink(configPath);
    }
  });

  it("둘 다 존재할 때 secrets.env_patterns를 우선하고 경고를 출력한다", async () => {
    const configPath  = `/tmp/prism-config-both-${Date.now()}.json`;
    const legacyPats  = ["LEGACY_TOKEN"];
    const newPats     = ["NEW_TOKEN"];
    const body        = {
      guard: {
        env_secret_patterns: legacyPats,
        secrets: { env_patterns: newPats },
      },
    };
    await writeFile(configPath, JSON.stringify(body), "utf-8");

    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      const cfg = await loadConfig(configPath);

      expect(stderrSpy).toHaveBeenCalledOnce();
      expect(String(stderrSpy.mock.calls[0][0])).toContain(
        "guard.env_secret_patterns is deprecated",
      );
      expect(cfg.guard.secrets?.env_patterns).toEqual(newPats);
      expect(cfg.guard.env_secret_patterns).toEqual(newPats);
    } finally {
      await unlink(configPath);
    }
  });

  it("둘 다 없으면 기본값이 적용되고 경고가 발생하지 않는다", async () => {
    const configPath = `/tmp/prism-config-neither-${Date.now()}.json`;
    const body       = { guard: { timeout_ms: 5000 } };
    await writeFile(configPath, JSON.stringify(body), "utf-8");

    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      const cfg = await loadConfig(configPath);

      expect(stderrSpy).not.toHaveBeenCalled();
      expect(cfg.guard.secrets?.env_patterns).toEqual(
        DEFAULT_CONFIG.guard.secrets?.env_patterns,
      );
      expect(cfg.guard.env_secret_patterns).toEqual(
        DEFAULT_CONFIG.guard.env_secret_patterns,
      );
    } finally {
      await unlink(configPath);
    }
  });
});
