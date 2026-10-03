import { describe, it, expect, vi, afterEach } from "vitest";
import { unlink, writeFile } from "node:fs/promises";
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import path from "node:path";
import { loadConfig, loadConfigMultiLayer, DEFAULT_CONFIG } from "../../src/config/loader.js";

/** 임시 디렉터리에 prism.config.json을 만들고 파일 경로를 반환한다. */
function tmpConfig(obj: unknown): string {
  const dir  = mkdtempSync(path.join(tmpdir(), "parism-cfg-"));
  const file = path.join(dir, "prism.config.json");
  writeFileSync(file, JSON.stringify(obj));
  return file;
}

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

describe("loadConfig() guard.secrets", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("secrets.env_patterns만 있을 때 경고 없이 그대로 사용한다", async () => {
    const configPath = `/tmp/prism-config-new-only-${Date.now()}.json`;
    const patterns   = ["NEW_TOKEN", "NEW_SECRET"];
    await writeFile(configPath, JSON.stringify({ guard: { secrets: { env_patterns: patterns } } }), "utf-8");

    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      const cfg = await loadConfig(configPath);

      expect(stderrSpy).not.toHaveBeenCalled();
      expect(cfg.guard.secrets?.env_patterns).toEqual(patterns);
    } finally {
      await unlink(configPath);
    }
  });

  it("제거된 env_secret_patterns 키는 경고하고 무시한다", async () => {
    const configPath = `/tmp/prism-config-removed-${Date.now()}.json`;
    await writeFile(configPath, JSON.stringify({ guard: { env_secret_patterns: ["LEGACY_TOKEN"] } }), "utf-8");

    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      const cfg = await loadConfig(configPath);

      expect(String(stderrSpy.mock.calls[0]![0])).toContain("env_secret_patterns was removed");
      expect(cfg.guard.secrets?.env_patterns).toEqual(DEFAULT_CONFIG.guard.secrets?.env_patterns);
      expect("env_secret_patterns" in cfg.guard).toBe(false);
    } finally {
      await unlink(configPath);
    }
  });

  it("둘 다 없으면 기본값이 적용되고 경고가 발생하지 않는다", async () => {
    const configPath = `/tmp/prism-config-neither-${Date.now()}.json`;
    await writeFile(configPath, JSON.stringify({ guard: { timeout_ms: 5000 } }), "utf-8");

    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      const cfg = await loadConfig(configPath);

      expect(stderrSpy).not.toHaveBeenCalled();
      expect(cfg.guard.secrets?.env_patterns).toEqual(DEFAULT_CONFIG.guard.secrets?.env_patterns);
    } finally {
      await unlink(configPath);
    }
  });
});

describe("loadConfigMultiLayer() — envToConfig 격리", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    for (const key of Object.keys(process.env)) {
      if (key.startsWith("PARISM_")) delete process.env[key];
    }
    Object.assign(process.env, originalEnv);
  });

  it("환경변수 미설정 시 project config의 allowed_commands가 보존된다", async () => {
    const projectPath = `/tmp/prism-multilayer-${Date.now()}.json`;
    const globalPath  = tmpConfig({ trust_project_config: true });
    const body = { guard: { allowed_commands: ["ls", "git", "cat"] } };
    await writeFile(projectPath, JSON.stringify(body), "utf-8");

    try {
      const cfg = await loadConfigMultiLayer({
        globalPath,
        projectPath,
        envPrefix: "PARISM_",
      });

      expect(cfg.guard.allowed_commands).toEqual(["ls", "git", "cat"]);
    } finally {
      await unlink(projectPath);
    }
  });

  it("환경변수 미설정 시 project config의 allowed_paths가 보존된다", async () => {
    const projectPath = `/tmp/prism-multilayer-paths-${Date.now()}.json`;
    const globalPath  = tmpConfig({ trust_project_config: true });
    const body = { guard: { allowed_paths: ["/home/user", "/tmp"] } };
    await writeFile(projectPath, JSON.stringify(body), "utf-8");

    try {
      const cfg = await loadConfigMultiLayer({
        globalPath,
        projectPath,
        envPrefix: "PARISM_",
      });

      expect(cfg.guard.allowed_paths).toEqual(["/home/user", "/tmp"]);
    } finally {
      await unlink(projectPath);
    }
  });

  it("PARISM_ALLOWED_COMMANDS 설정 시 해당 필드만 덮어쓴다", async () => {
    const projectPath = `/tmp/prism-multilayer-env-${Date.now()}.json`;
    const globalPath  = tmpConfig({ trust_project_config: true });
    const body = {
      guard: {
        allowed_commands: ["ls", "git"],
        allowed_paths: ["/home/user"],
        timeout_ms: 5000,
      },
    };
    await writeFile(projectPath, JSON.stringify(body), "utf-8");

    process.env.PARISM_ALLOWED_COMMANDS = "echo,curl";

    try {
      const cfg = await loadConfigMultiLayer({
        globalPath,
        projectPath,
        envPrefix: "PARISM_",
      });

      expect(cfg.guard.allowed_commands).toEqual(["echo", "curl"]);
      expect(cfg.guard.allowed_paths).toEqual(["/home/user"]);
      expect(cfg.guard.timeout_ms).toBe(5000);
    } finally {
      delete process.env.PARISM_ALLOWED_COMMANDS;
      await unlink(projectPath);
    }
  });

  it("환경변수가 하나도 없으면 기본값을 보존한다", async () => {
    for (const key of Object.keys(process.env)) {
      if (key.startsWith("PARISM_")) delete process.env[key];
    }

    const cfg = await loadConfigMultiLayer({
      globalPath: "/tmp/__nonexistent__.json",
      projectPath: "/tmp/__nonexistent__.json",
      envPrefix: "PARISM_",
    });

    expect(cfg.guard.allowed_commands).toEqual(DEFAULT_CONFIG.guard.allowed_commands);
    expect(cfg.guard.block_patterns).toEqual(DEFAULT_CONFIG.guard.block_patterns);
    expect(cfg.guard.timeout_ms).toBe(DEFAULT_CONFIG.guard.timeout_ms);
    expect(cfg.telemetry?.enabled).toBe(false);
  });

  it("PARISM_TELEMETRY_ENABLED=true 설정 시 telemetry.enabled가 true로 반영된다", async () => {
    process.env.PARISM_TELEMETRY_ENABLED = "true";

    try {
      const cfg = await loadConfigMultiLayer({
        globalPath: "/tmp/__nonexistent__.json",
        projectPath: "/tmp/__nonexistent__.json",
        envPrefix: "PARISM_",
      });

      expect(cfg.telemetry?.enabled).toBe(true);
    } finally {
      delete process.env.PARISM_TELEMETRY_ENABLED;
    }
  });
});

describe("telemetry 설정 배선", () => {
  it("DEFAULT_CONFIG.telemetry.enabled는 false이다", () => {
    expect(DEFAULT_CONFIG.telemetry?.enabled).toBe(false);
  });

  it("설정 파일의 telemetry.enabled=true가 loadConfig 결과에 반영된다", async () => {
    const configPath = `/tmp/prism-config-telemetry-${Date.now()}.json`;
    const body        = { telemetry: { enabled: true } };
    await writeFile(configPath, JSON.stringify(body), "utf-8");

    try {
      const cfg = await loadConfig(configPath);
      expect(cfg.telemetry?.enabled).toBe(true);
    } finally {
      await unlink(configPath);
    }
  });

  it("설정 파일에 telemetry가 없으면 기본값(false)을 유지한다", async () => {
    const configPath = `/tmp/prism-config-telemetry-default-${Date.now()}.json`;
    const body        = { guard: { timeout_ms: 3000 } };
    await writeFile(configPath, JSON.stringify(body), "utf-8");

    try {
      const cfg = await loadConfig(configPath);
      expect(cfg.telemetry?.enabled).toBe(false);
    } finally {
      await unlink(configPath);
    }
  });

  it("JSON 파싱 실패 시 stderr에 경고를 출력한다", async () => {
    const configPath = `/tmp/prism-config-invalid-warn-${Date.now()}.json`;
    await writeFile(configPath, "{ invalid json }", "utf-8");

    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      await loadConfig(configPath);
      expect(stderrSpy).toHaveBeenCalled();
      expect(String(stderrSpy.mock.calls[0][0])).toContain("failed to load");
    } finally {
      stderrSpy.mockRestore();
      await unlink(configPath);
    }
  });

  it("파일이 없으면 stderr 경고를 출력하지 않는다", async () => {
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      await loadConfig("/tmp/__nonexistent_prism_config__.json");
      expect(stderrSpy).not.toHaveBeenCalled();
    } finally {
      stderrSpy.mockRestore();
    }
  });
});

describe("loadConfig() 반환값 격리", () => {
  it("파일이 없을 때 반환한 설정을 바꿔도 DEFAULT_CONFIG는 변하지 않는다", async () => {
    const cfg = await loadConfig("/tmp/__nonexistent_prism_config__.json");
    cfg.guard.allowed_commands.push("bash");
    expect(DEFAULT_CONFIG.guard.allowed_commands).not.toContain("bash");
  });
});

describe("설정 신뢰 경계", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.PARISM_TIMEOUT_MS;
  });

  it("프로젝트 설정은 allowed_commands를 넓히지 못한다", async () => {
    const projectPath = tmpConfig({ guard: { allowed_commands: ["ls", "bash"] } });
    const cfg = await loadConfigMultiLayer({ globalPath: "/nonexistent", projectPath });
    expect(cfg.guard.allowed_commands).toContain("ls");
    expect(cfg.guard.allowed_commands).not.toContain("bash");
  });

  it("전역 trust_project_config=true면 프로젝트 설정이 넓힐 수 있다", async () => {
    const globalPath  = tmpConfig({ trust_project_config: true });
    const projectPath = tmpConfig({ guard: { allowed_commands: ["ls", "make"] } });
    const cfg = await loadConfigMultiLayer({ globalPath, projectPath });
    expect(cfg.guard.allowed_commands).toContain("make");
  });

  it("신뢰하지 않는 프로젝트 설정의 command_policies는 무시된다", async () => {
    const projectPath = tmpConfig({ guard: { command_policies: { npm: { subcommands: ["run"], flags: {}, positionals: "any" } } } });
    const cfg = await loadConfigMultiLayer({ globalPath: "/nonexistent", projectPath });
    expect(cfg.guard.command_policies).toBeUndefined();
  });

  it("신뢰하는 프로젝트 설정의 command_policies는 명령 단위로 병합된다", async () => {
    const globalPath  = tmpConfig({ trust_project_config: true, guard: { command_policies: { git: { subcommands: ["status"], flags: {}, positionals: "none" } } } });
    const projectPath = tmpConfig({ guard: { command_policies: { npm: { subcommands: ["run"], flags: {}, positionals: "any" } } } });
    const cfg = await loadConfigMultiLayer({ globalPath, projectPath });
    expect(cfg.guard.command_policies?.npm?.subcommands).toEqual(["run"]);
    expect(cfg.guard.command_policies?.git?.subcommands).toEqual(["status"]);
  });

  it("프로젝트 설정의 trust_project_config는 무시된다", async () => {
    const projectPath = tmpConfig({ trust_project_config: true, guard: { allowed_commands: ["make"] } });
    const cfg = await loadConfigMultiLayer({ globalPath: "/nonexistent", projectPath });
    expect(cfg.guard.allowed_commands).not.toContain("make");
    expect(cfg.trust_project_config).toBeUndefined();
  });

  it("프로젝트 allowed_paths의 상대경로는 설정 파일 디렉터리 기준이다", async () => {
    const base        = realpathSync(tmpdir());
    const globalPath  = tmpConfig({ guard: { allowed_paths: [base] } });
    const projectPath = tmpConfig({ guard: { allowed_paths: ["./"] } });
    const cfg = await loadConfigMultiLayer({ globalPath, projectPath });
    expect(cfg.guard.allowed_paths).toEqual([realpathSync(path.dirname(projectPath))]);
  });

  it("프로젝트 allowed_paths는 기본 경로 밖으로 넓힐 수 없다", async () => {
    const globalPath  = tmpConfig({ guard: { allowed_paths: [realpathSync(tmpdir())] } });
    const projectPath = tmpConfig({ guard: { allowed_paths: ["/etc"] } });
    const cfg = await loadConfigMultiLayer({ globalPath, projectPath });
    expect(cfg.guard.allowed_paths).toEqual([realpathSync(tmpdir())]);
  });

  it("프로젝트 allowed_paths는 링크를 해석한 실경로로 비교하고 저장한다", async () => {
    const base    = realpathSync(mkdtempSync(path.join(tmpdir(), "parism-base-")));
    const outside = mkdtempSync(path.join(tmpdir(), "parism-outside-"));
    symlinkSync(outside, path.join(base, "link"));
    symlinkSync("/", path.join(base, "root"));
    mkdirSync(path.join(base, "sub"));
    const projectPath = path.join(base, "prism.config.json");
    writeFileSync(projectPath, JSON.stringify({ guard: { allowed_paths: ["link", "root", "sub"] } }));
    const globalPath  = tmpConfig({ guard: { allowed_paths: [base] } });
    const spy         = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const cfg         = await loadConfigMultiLayer({ globalPath, projectPath });
    spy.mockRestore();
    expect(cfg.guard.allowed_paths).toEqual([path.join(base, "sub")]);
  });

  it("링크 항목만 남으면 기준 경로를 유지한다", async () => {
    const base = realpathSync(mkdtempSync(path.join(tmpdir(), "parism-base-")));
    symlinkSync("/", path.join(base, "root"));
    const projectPath = path.join(base, "prism.config.json");
    writeFileSync(projectPath, JSON.stringify({ guard: { allowed_paths: ["root"] } }));
    const globalPath  = tmpConfig({ guard: { allowed_paths: [base] } });
    const spy         = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const cfg         = await loadConfigMultiLayer({ globalPath, projectPath });
    spy.mockRestore();
    expect(cfg.guard.allowed_paths).toEqual([base]);
  });

  it("기준 경로가 링크여도 실경로 기준으로 안쪽 항목을 남긴다", async () => {
    const base     = realpathSync(mkdtempSync(path.join(tmpdir(), "parism-base-")));
    const linkHome = mkdtempSync(path.join(tmpdir(), "parism-linkhome-"));
    const baseLink = path.join(linkHome, "base");
    symlinkSync(base, baseLink);
    mkdirSync(path.join(base, "sub"));
    const projectPath = path.join(base, "prism.config.json");
    writeFileSync(projectPath, JSON.stringify({ guard: { allowed_paths: ["sub"] } }));
    const globalPath  = tmpConfig({ guard: { allowed_paths: [baseLink] } });
    const cfg         = await loadConfigMultiLayer({ globalPath, projectPath });
    expect(cfg.guard.allowed_paths).toEqual([path.join(base, "sub")]);
  });

  it("프로젝트가 allowed_paths를 빈 배열로 지정해도 제한이 풀리지 않는다", async () => {
    const globalPath  = tmpConfig({ guard: { allowed_paths: [realpathSync(tmpdir())] } });
    const projectPath = tmpConfig({ guard: { allowed_paths: [] } });
    const cfg = await loadConfigMultiLayer({ globalPath, projectPath });
    expect(cfg.guard.allowed_paths).toEqual([realpathSync(tmpdir())]);
  });

  it("프로젝트 timeout_ms와 max_output_bytes는 줄이기만 한다", async () => {
    const projectPath = tmpConfig({ guard: { timeout_ms: 999999, max_output_bytes: 0 } });
    const cfg = await loadConfigMultiLayer({ globalPath: "/nonexistent", projectPath });
    expect(cfg.guard.timeout_ms).toBe(DEFAULT_CONFIG.guard.timeout_ms);
    expect(cfg.guard.max_output_bytes).toBe(DEFAULT_CONFIG.guard.max_output_bytes);

    const smaller = tmpConfig({ guard: { timeout_ms: 500, max_output_bytes: 1024 } });
    const cfg2    = await loadConfigMultiLayer({ globalPath: "/nonexistent", projectPath: smaller });
    expect(cfg2.guard.timeout_ms).toBe(500);
    expect(cfg2.guard.max_output_bytes).toBe(1024);
  });

  it("프로젝트 timeout_ms가 0이거나 음수이거나 유한 수가 아니면 무시한다", async () => {
    for (const bad of [0, -1, "5000", null]) {
      const projectPath = tmpConfig({ guard: { timeout_ms: bad } });
      const cfg = await loadConfigMultiLayer({ globalPath: "/nonexistent", projectPath });
      expect(cfg.guard.timeout_ms).toBe(DEFAULT_CONFIG.guard.timeout_ms);
    }
  });

  it("프로젝트 timeout_ms가 유효하고 더 작으면 그 값을 쓴다", async () => {
    const projectPath = tmpConfig({ guard: { timeout_ms: 2500 } });
    const cfg = await loadConfigMultiLayer({ globalPath: "/nonexistent", projectPath });
    expect(cfg.guard.timeout_ms).toBe(2500);
  });

  it("전역 timeout_ms가 0(무제한)이면 유효한 양수 프로젝트 값이 한도가 된다", async () => {
    const globalPath  = tmpConfig({ guard: { timeout_ms: 0 } });
    const projectPath = tmpConfig({ guard: { timeout_ms: 3000 } });
    const cfg = await loadConfigMultiLayer({ globalPath, projectPath });
    expect(cfg.guard.timeout_ms).toBe(3000);
  });

  it("전역이 max_output_bytes 무제한(0)이면 프로젝트 값이 그대로 한도가 된다", async () => {
    const globalPath  = tmpConfig({ guard: { max_output_bytes: 0 } });
    const projectPath = tmpConfig({ guard: { max_output_bytes: 2048 } });
    const cfg = await loadConfigMultiLayer({ globalPath, projectPath });
    expect(cfg.guard.max_output_bytes).toBe(2048);
  });

  it("프로젝트 block_patterns와 command_arg_restrictions는 합집합이다", async () => {
    const projectPath = tmpConfig({
      guard: {
        block_patterns:           ["rm"],
        command_arg_restrictions: {
          node: { blocked_flags: [] },
          git:  { blocked_flags: ["push"] },
        },
      },
    });
    const cfg = await loadConfigMultiLayer({ globalPath: "/nonexistent", projectPath });
    expect(cfg.guard.block_patterns).toEqual(expect.arrayContaining([...DEFAULT_CONFIG.guard.block_patterns, "rm"]));
    expect(cfg.guard.command_arg_restrictions.node.blocked_flags)
      .toEqual(DEFAULT_CONFIG.guard.command_arg_restrictions.node.blocked_flags);
    expect(cfg.guard.command_arg_restrictions.git.blocked_flags).toEqual(["push"]);
  });

  it("cwd가 / 이면 기본 allowed_paths를 홈 디렉터리로 제한하고 경고한다", async () => {
    const cwdSpy    = vi.spyOn(process, "cwd").mockReturnValue("/");
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const cfg       = await loadConfigMultiLayer({ globalPath: "/nonexistent", projectPath: "/nonexistent" });
    const warned    = stderrSpy.mock.calls.some(c => String(c[0]).includes("WARNING"));
    cwdSpy.mockRestore();
    stderrSpy.mockRestore();
    expect(cfg.guard.allowed_paths).toEqual([homedir()]);
    expect(warned).toBe(true);
  });

  it("레거시 키를 쓰지 않으면 제거 경고를 내지 않는다", async () => {
    const spy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    await loadConfigMultiLayer({ globalPath: "/nonexistent", projectPath: "/nonexistent" });
    const warned = spy.mock.calls.some(c => String(c[0]).includes("env_secret_patterns"));
    spy.mockRestore();
    expect(warned).toBe(false);
  });

  it("전역 설정의 제거된 env_secret_patterns 키는 경고하고 무시한다", async () => {
    const spy        = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const globalPath = tmpConfig({ guard: { env_secret_patterns: ["MY_TOKEN"] } });
    const cfg        = await loadConfigMultiLayer({ globalPath, projectPath: "/nonexistent" });
    const warned     = spy.mock.calls.some(c => String(c[0]).includes("env_secret_patterns was removed"));
    spy.mockRestore();
    expect(warned).toBe(true);
    expect(cfg.guard.secrets?.env_patterns).toEqual(DEFAULT_CONFIG.guard.secrets?.env_patterns);
  });

  it("숫자가 아닌 PARISM_TIMEOUT_MS는 무시하고 경고한다", async () => {
    const spy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    process.env.PARISM_TIMEOUT_MS = "abc";
    const cfg    = await loadConfigMultiLayer({ globalPath: "/nonexistent", projectPath: "/nonexistent" });
    const warned = spy.mock.calls.some(c => String(c[0]).includes("invalid PARISM_TIMEOUT_MS"));
    spy.mockRestore();
    expect(cfg.guard.timeout_ms).toBe(10000);
    expect(warned).toBe(true);
  });
});

describe("설정 값 검증", () => {
  const writeRaw = (text: string): string => {
    const dir  = mkdtempSync(path.join(tmpdir(), "parism-cfg-"));
    const file = path.join(dir, "prism.config.json");
    writeFileSync(file, text);
    return file;
  };

  /** stderr 경고를 모으면서 fn을 실행하고, needle을 포함한 경고 수를 돌려준다. */
  async function countWarnings<T>(needle: string, fn: () => Promise<T>): Promise<{ result: T; count: number }> {
    const spy    = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      const result = await fn();
      const count  = spy.mock.calls.filter(c => String(c[0]).includes(needle)).length;
      return { result, count };
    } finally {
      spy.mockRestore();
    }
  }

  afterEach(() => {
    for (const key of Object.keys(process.env)) {
      if (key.startsWith("PARISM_")) delete process.env[key];
    }
  });

  const badLimits: [string, string][] = [
    ["음수", "-1"],
    ["무한대", "1e999"],
    ["소수", "1.5"],
    ["문자열", "\"100\""],
    ["null", "null"],
    ["배열", "[1]"],
  ];

  for (const [label, literal] of badLimits) {
    it(`전역 설정의 ${label} max_output_bytes는 경고 1회 후 기본값을 유지한다`, async () => {
      const globalPath = writeRaw(`{ "guard": { "max_output_bytes": ${literal} } }`);
      const { result, count } = await countWarnings("guard.max_output_bytes", () =>
        loadConfigMultiLayer({ globalPath, projectPath: "/nonexistent" }));
      expect(result.guard.max_output_bytes).toBe(DEFAULT_CONFIG.guard.max_output_bytes);
      expect(count).toBe(1);
    });

    it(`프로젝트 설정의 ${label} max_output_bytes는 경고 1회 후 기준값을 유지한다`, async () => {
      const projectPath = writeRaw(`{ "guard": { "max_output_bytes": ${literal} } }`);
      const { result, count } = await countWarnings("guard.max_output_bytes", () =>
        loadConfigMultiLayer({ globalPath: "/nonexistent", projectPath }));
      expect(result.guard.max_output_bytes).toBe(DEFAULT_CONFIG.guard.max_output_bytes);
      expect(count).toBe(1);
    });

    it(`loadConfig의 ${label} max_output_bytes는 경고 1회 후 기본값을 유지한다`, async () => {
      const configPath = writeRaw(`{ "guard": { "max_output_bytes": ${literal} } }`);
      const { result, count } = await countWarnings("guard.max_output_bytes", () => loadConfig(configPath));
      expect(result.guard.max_output_bytes).toBe(DEFAULT_CONFIG.guard.max_output_bytes);
      expect(count).toBe(1);
    });
  }

  for (const value of ["-1", "NaN", "1.5", "Infinity"]) {
    it(`환경 변수 PARISM_MAX_OUTPUT_BYTES=${value}는 경고 1회 후 기본값을 유지한다`, async () => {
      process.env.PARISM_MAX_OUTPUT_BYTES = value;
      const { result, count } = await countWarnings("PARISM_MAX_OUTPUT_BYTES", () =>
        loadConfigMultiLayer({ globalPath: "/nonexistent", projectPath: "/nonexistent" }));
      expect(result.guard.max_output_bytes).toBe(DEFAULT_CONFIG.guard.max_output_bytes);
      expect(count).toBe(1);
    });
  }

  const badLists: [string, string][] = [
    ["문자열", "\"ls\""],
    ["null", "null"],
    ["숫자 원소 배열", "[1, 2]"],
    ["객체", "{}"],
  ];

  for (const [label, literal] of badLists) {
    it(`전역 설정의 ${label} allowed_commands는 경고 1회 후 기본 목록을 유지한다`, async () => {
      const globalPath = writeRaw(`{ "guard": { "allowed_commands": ${literal} } }`);
      const { result, count } = await countWarnings("guard.allowed_commands", () =>
        loadConfigMultiLayer({ globalPath, projectPath: "/nonexistent" }));
      expect(result.guard.allowed_commands).toEqual(DEFAULT_CONFIG.guard.allowed_commands);
      expect(count).toBe(1);
    });

    it(`프로젝트 설정의 ${label} allowed_paths는 기동을 막지 않고 기준 경로를 유지한다`, async () => {
      const base        = realpathSync(tmpdir());
      const globalPath  = tmpConfig({ guard: { allowed_paths: [base] } });
      const projectPath = writeRaw(`{ "guard": { "allowed_paths": ${literal} } }`);
      const { result, count } = await countWarnings("guard.allowed_paths", () =>
        loadConfigMultiLayer({ globalPath, projectPath }));
      expect(result.guard.allowed_paths).toEqual([base]);
      expect(count).toBe(1);
    });
  }

  it("유효한 필드는 무효 필드와 같은 레이어에 있어도 반영된다", async () => {
    const globalPath = tmpConfig({ guard: { timeout_ms: 4000, max_items: -5 } });
    const { result, count } = await countWarnings("guard.max_items", () =>
      loadConfigMultiLayer({ globalPath, projectPath: "/nonexistent" }));
    expect(result.guard.timeout_ms).toBe(4000);
    expect(result.guard.max_items).toBe(DEFAULT_CONFIG.guard.max_items);
    expect(count).toBe(1);
  });

  it("guard가 객체가 아니면 경고 후 기본 guard를 유지한다", async () => {
    const globalPath = tmpConfig({ guard: "readonly" });
    const { result, count } = await countWarnings("guard", () =>
      loadConfigMultiLayer({ globalPath, projectPath: "/nonexistent" }));
    expect(result.guard.allowed_commands).toEqual(DEFAULT_CONFIG.guard.allowed_commands);
    expect(count).toBe(1);
  });

  it("최상위가 객체가 아닌 설정 파일은 경고 후 무시한다", async () => {
    const globalPath = writeRaw("[1, 2]");
    const { result, count } = await countWarnings("WARNING", () =>
      loadConfigMultiLayer({ globalPath, projectPath: "/nonexistent" }));
    expect(result.guard.allowed_commands).toEqual(DEFAULT_CONFIG.guard.allowed_commands);
    expect(count).toBe(1);
  });

  it("잘못된 profile 값은 경고 후 무시한다", async () => {
    const globalPath = tmpConfig({ guard: { profile: "admin" } });
    const { result, count } = await countWarnings("guard.profile", () =>
      loadConfigMultiLayer({ globalPath, projectPath: "/nonexistent" }));
    expect(result.guard.profile).toBeUndefined();
    expect(count).toBe(1);
  });

  it("형식이 틀린 command_policies 항목은 경고 후 그 항목만 무시한다", async () => {
    const globalPath = tmpConfig({
      guard: {
        command_policies: {
          git:    { flags: "all", positionals: "any" },
          mytool: { flags: { "-v": "bool" }, positionals: "none" },
        },
      },
    });
    const { result, count } = await countWarnings("guard.command_policies.git", () =>
      loadConfigMultiLayer({ globalPath, projectPath: "/nonexistent" }));
    expect(result.guard.command_policies?.git).toBeUndefined();
    expect(result.guard.command_policies?.mytool).toEqual({ flags: { "-v": "bool" }, positionals: "none" });
    expect(count).toBe(1);
  });

  it("알 수 없는 정책 키가 있는 command_policies 항목은 무시한다", async () => {
    const globalPath = tmpConfig({ guard: { command_policies: { mytool: { flags: {}, positionals: "none", subcommand: ["x"] } } } });
    const { result, count } = await countWarnings("guard.command_policies.mytool", () =>
      loadConfigMultiLayer({ globalPath, projectPath: "/nonexistent" }));
    expect(result.guard.command_policies?.mytool).toBeUndefined();
    expect(count).toBe(1);
  });

  it("잘못된 secrets 하위 값은 경고 후 그 값만 무시한다", async () => {
    const globalPath = tmpConfig({ guard: { secrets: { env_patterns: "TOKEN", output_redaction_enabled: true } } });
    const { result, count } = await countWarnings("guard.secrets.env_patterns", () =>
      loadConfigMultiLayer({ globalPath, projectPath: "/nonexistent" }));
    expect(result.guard.secrets?.env_patterns).toEqual(DEFAULT_CONFIG.guard.secrets?.env_patterns);
    expect(result.guard.secrets?.output_redaction_enabled).toBe(true);
    expect(count).toBe(1);
  });

  it("잘못된 parsers와 telemetry 값은 경고 후 무시한다", async () => {
    const globalPath = tmpConfig({ parsers: { strict_schemas: "yes", adaptive_format_threshold: { compact: -1 } }, telemetry: { enabled: 1 } });
    const spy        = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const cfg        = await loadConfigMultiLayer({ globalPath, projectPath: "/nonexistent" });
    const warnings   = spy.mock.calls.map(c => String(c[0]));
    spy.mockRestore();
    expect(cfg.parsers?.strict_schemas).toBe(false);
    expect(cfg.parsers?.adaptive_format_threshold?.compact).toBe(50);
    expect(cfg.telemetry?.enabled).toBe(false);
    expect(warnings.filter(w => w.includes("parsers.strict_schemas"))).toHaveLength(1);
    expect(warnings.filter(w => w.includes("parsers.adaptive_format_threshold.compact"))).toHaveLength(1);
    expect(warnings.filter(w => w.includes("telemetry.enabled"))).toHaveLength(1);
  });

  it("빈 PARISM_ALLOWED_PATHS는 경고 후 무시해 경로 제한을 유지한다", async () => {
    for (const value of ["", " , "]) {
      process.env.PARISM_ALLOWED_PATHS = value;
      const { result, count } = await countWarnings("PARISM_ALLOWED_PATHS", () =>
        loadConfigMultiLayer({ globalPath: "/nonexistent", projectPath: "/nonexistent" }));
      expect(result.guard.allowed_paths).toEqual([process.cwd()]);
      expect(count).toBe(1);
    }
  });

  it("빈 PARISM_ALLOWED_COMMANDS는 경고 후 무시한다", async () => {
    process.env.PARISM_ALLOWED_COMMANDS = "";
    const { result, count } = await countWarnings("PARISM_ALLOWED_COMMANDS", () =>
      loadConfigMultiLayer({ globalPath: "/nonexistent", projectPath: "/nonexistent" }));
    expect(result.guard.allowed_commands).toEqual(DEFAULT_CONFIG.guard.allowed_commands);
    expect(count).toBe(1);
  });

  it("유효한 설정은 경고를 내지 않는다", async () => {
    const globalPath = tmpConfig({ guard: { timeout_ms: 0, max_output_bytes: 0, allowed_commands: ["ls"], profile: "build" }, parsers: { strict_schemas: true } });
    const { result, count } = await countWarnings("WARNING", () =>
      loadConfigMultiLayer({ globalPath, projectPath: "/nonexistent" }));
    expect(result.guard.timeout_ms).toBe(0);
    expect(result.guard.profile).toBe("build");
    expect(count).toBe(0);
  });

  it("loadConfig도 cwd가 / 이면 기본 allowed_paths를 홈 디렉터리로 제한한다", async () => {
    const cwdSpy = vi.spyOn(process, "cwd").mockReturnValue("/");
    const { result, count } = await countWarnings("cwd is /", () => loadConfig("/tmp/__nonexistent_prism_config__.json"));
    cwdSpy.mockRestore();
    expect(result.guard.allowed_paths).toEqual([homedir()]);
    expect(count).toBe(1);
  });

  it("loadConfig는 설정 파일에 allowed_paths가 없을 때도 cwd / 규칙을 따른다", async () => {
    const configPath = tmpConfig({ guard: { timeout_ms: 3000 } });
    const cwdSpy     = vi.spyOn(process, "cwd").mockReturnValue("/");
    const { result } = await countWarnings("cwd is /", () => loadConfig(configPath));
    cwdSpy.mockRestore();
    expect(result.guard.allowed_paths).toEqual([homedir()]);
    expect(result.guard.timeout_ms).toBe(3000);
  });
});

describe("실행 자원 설정", () => {
  it("max_page_size와 max_concurrency 기본값은 1000과 4다", () => {
    expect(DEFAULT_CONFIG.guard.max_page_size).toBe(1000);
    expect(DEFAULT_CONFIG.guard.max_concurrency).toBe(4);
  });

  it("전역 설정의 max_concurrency와 max_page_size를 반영한다", async () => {
    const globalPath = tmpConfig({ guard: { max_concurrency: 2, max_page_size: 50 } });
    const cfg        = await loadConfigMultiLayer({ globalPath, projectPath: "/nonexistent" });
    expect(cfg.guard.max_concurrency).toBe(2);
    expect(cfg.guard.max_page_size).toBe(50);
  });

  it("1 이상 정수가 아닌 max_concurrency와 max_page_size는 경고 후 무시한다", async () => {
    for (const bad of [0, -1, 1.5, "4", null]) {
      const globalPath = tmpConfig({ guard: { max_concurrency: bad, max_page_size: bad } });
      const spy        = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
      const cfg        = await loadConfigMultiLayer({ globalPath, projectPath: "/nonexistent" });
      const warnings   = spy.mock.calls.map(c => String(c[0]));
      spy.mockRestore();
      expect(cfg.guard.max_concurrency).toBe(4);
      expect(cfg.guard.max_page_size).toBe(1000);
      expect(warnings.filter(w => w.includes("guard.max_concurrency"))).toHaveLength(1);
      expect(warnings.filter(w => w.includes("guard.max_page_size"))).toHaveLength(1);
    }
  });

  it("default_page_size는 max_page_size를 넘지 않는다", async () => {
    const cases: [Record<string, number>, number][] = [
      [{ default_page_size: 5000 }, 1000],
      [{ max_page_size: 50 }, 50],
      [{ default_page_size: 20, max_page_size: 50 }, 20],
      [{ default_page_size: 0, max_page_size: 50 }, 0],
    ];
    for (const [guard, expected] of cases) {
      const globalPath = tmpConfig({ guard });
      const cfg        = await loadConfigMultiLayer({ globalPath, projectPath: "/nonexistent" });
      expect([guard, cfg.guard.default_page_size]).toEqual([guard, expected]);
      expect((await loadConfig(globalPath)).guard.default_page_size).toBe(expected);
    }
  });
});

describe("외부 파서 격리 설정", () => {
  afterEach(() => vi.restoreAllMocks());

  it("기본값은 워커 격리, 시간 상한 500ms, 메모리 상한 128MB다", async () => {
    const cfg = await loadConfigMultiLayer({ globalPath: "/nonexistent", projectPath: "/nonexistent" });
    expect(cfg.parsers?.external_isolation).toBe("worker");
    expect(cfg.parsers?.external_time_limit_ms).toBe(500);
    expect(cfg.parsers?.external_memory_limit_mb).toBe(128);
  });

  it("전역 설정은 격리를 끄거나 상한을 바꿀 수 있다", async () => {
    const globalPath = tmpConfig({ parsers: { external_isolation: "none", external_time_limit_ms: 2000, external_memory_limit_mb: 256 } });
    const cfg        = await loadConfigMultiLayer({ globalPath, projectPath: "/nonexistent" });
    expect(cfg.parsers?.external_isolation).toBe("none");
    expect(cfg.parsers?.external_time_limit_ms).toBe(2000);
    expect(cfg.parsers?.external_memory_limit_mb).toBe(256);
  });

  it("잘못된 값은 경고 후 기본값을 유지한다", async () => {
    const globalPath = tmpConfig({ parsers: { external_isolation: "process", external_time_limit_ms: 0, external_memory_limit_mb: 1.5 } });
    const spy        = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const cfg        = await loadConfigMultiLayer({ globalPath, projectPath: "/nonexistent" });
    const warnings   = spy.mock.calls.map(c => String(c[0]));
    expect(cfg.parsers?.external_isolation).toBe("worker");
    expect(cfg.parsers?.external_time_limit_ms).toBe(500);
    expect(cfg.parsers?.external_memory_limit_mb).toBe(128);
    for (const key of ["external_isolation", "external_time_limit_ms", "external_memory_limit_mb"]) {
      expect(warnings.filter(w => w.includes(`parsers.${key}`))).toHaveLength(1);
    }
  });

  it("신뢰하지 않는 프로젝트 설정은 격리를 끄거나 상한을 올리지 못한다", async () => {
    const projectPath = tmpConfig({ parsers: { external_isolation: "none", external_time_limit_ms: 60000, external_memory_limit_mb: 4096 } });
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const cfg = await loadConfigMultiLayer({ globalPath: "/nonexistent", projectPath });
    expect(cfg.parsers?.external_isolation).toBe("worker");
    expect(cfg.parsers?.external_time_limit_ms).toBe(500);
    expect(cfg.parsers?.external_memory_limit_mb).toBe(128);
  });

  it("신뢰하지 않는 프로젝트 설정도 상한을 낮추거나 격리를 켤 수는 있다", async () => {
    const globalPath  = tmpConfig({ parsers: { external_isolation: "none" } });
    const projectPath = tmpConfig({ parsers: { external_isolation: "worker", external_time_limit_ms: 200, external_memory_limit_mb: 64 } });
    const cfg         = await loadConfigMultiLayer({ globalPath, projectPath });
    expect(cfg.parsers?.external_isolation).toBe("worker");
    expect(cfg.parsers?.external_time_limit_ms).toBe(200);
    expect(cfg.parsers?.external_memory_limit_mb).toBe(64);
  });

  it("신뢰하는 프로젝트 설정은 격리 설정을 바꿀 수 있다", async () => {
    const globalPath  = tmpConfig({ trust_project_config: true });
    const projectPath = tmpConfig({ parsers: { external_isolation: "none", external_time_limit_ms: 3000 } });
    const cfg         = await loadConfigMultiLayer({ globalPath, projectPath });
    expect(cfg.parsers?.external_isolation).toBe("none");
    expect(cfg.parsers?.external_time_limit_ms).toBe(3000);
  });
});
