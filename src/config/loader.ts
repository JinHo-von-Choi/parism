import { readFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";

export interface CommandArgRestriction {
  blocked_flags: string[];
}

export interface PrismGuardSecretsConfig {
  env_patterns?:             string[];  // 자식 프로세스 env에서 제거할 변수명 패턴
  output_patterns?:          string[];  // Phase 2.2 placeholder: stdout/stderr 리댁션 패턴
  output_redaction_enabled?: boolean;   // Phase 2.2 placeholder: 리댁션 활성화 여부
}

export interface PrismGuardConfig {
  allowed_commands:         string[];
  allowed_paths:            string[];
  timeout_ms:               number;
  max_output_bytes:         number;   // stdout 최대 크기(bytes). 0=무제한
  max_items:                number;   // 리스트 파서 최대 항목 수. 0=무제한
  default_page_size:        number;   // run_paged 기본 줄 수, 0=비활성
  block_patterns:           string[];
  command_arg_restrictions: Record<string, CommandArgRestriction>;
  /** @deprecated guard.secrets.env_patterns 으로 이전하세요. v2.0.0 제거 예정. */
  env_secret_patterns:      string[];
  secrets?:                 PrismGuardSecretsConfig;
  profile?:                 "readonly" | "build";
}

export interface PrismParsersConfig {
  strict_schemas?: boolean;
  adaptive_format_threshold?: {
    json?: number;
    compact?: number;
    json_no_raw?: number;
  };
}

export interface PrismConfig {
  guard:      PrismGuardConfig;
  /** 전역 설정 파일에서만 유효. true면 프로젝트 설정이 가드를 넓힐 수 있다. */
  trust_project_config?: boolean;
  parsers?:   PrismParsersConfig;
  telemetry?: PrismTelemetryConfig;
}

export interface PrismTelemetryConfig {
  enabled?: boolean;
}

type PartialPrismGuardConfig = Partial<PrismGuardConfig>;

const DEFAULT_ENV_SECRET_PATTERNS = [
  "TOKEN", "SECRET", "AUTHZ", "PASSWORD", "PASSWD", "CREDENTIAL",
];

export const DEFAULT_CONFIG: PrismConfig = {
  parsers: {
    strict_schemas: false,
    adaptive_format_threshold: {
      json: 0,
      compact: 50,
      json_no_raw: 200,
    },
  },
  telemetry: {
    enabled: false,
  },
  guard: {
    allowed_commands: [
      "ls", "find", "stat", "du", "df", "tree",
      "ps",
      "ping", "curl", "netstat",
      "grep", "wc", "head", "tail", "cat",
      "git",
      "env", "pwd", "which",
      "echo", "date", "uname", "hostname",
      "kubectl", "docker", "gh",
      "systemctl", "journalctl",
      "helm", "terraform", "apt", "brew",
      "npm", "pnpm", "yarn", "cargo",
    ],
    allowed_paths:    [process.cwd()],
    timeout_ms:       10000,
    max_output_bytes:  102400,   // 100 KB
    max_items:         500,
    default_page_size: 100,
    block_patterns: [";", "$(", "`", "&&", "||", ">", ">>", "<", "|"],
    command_arg_restrictions: {
      node: { blocked_flags: ["-e", "--eval", "-r", "--require", "-p", "--print", "--input-type"] },
      npx:  { blocked_flags: ["--yes", "-y"] },
      curl: {
        blocked_flags: [
          "-d", "--data", "-F", "--upload-file", "-T",
          "-K", "--config", "-o", "--output", "-O",
        ],
      },
    },
    env_secret_patterns: DEFAULT_ENV_SECRET_PATTERNS,
    secrets: {
      env_patterns:             DEFAULT_ENV_SECRET_PATTERNS,
      output_patterns:          [],
      output_redaction_enabled: false,
    },
  },
};

/**
 * guard 설정을 기본값과 병합한다.
 * command_arg_restrictions는 하위 키 기준으로 깊은 병합하여 기본 보안 제한 유실을 방지한다.
 */
function mergeGuardConfig(userGuard: PartialPrismGuardConfig): PrismGuardConfig {
  const mergedCommandArgRestrictions = {
    ...DEFAULT_CONFIG.guard.command_arg_restrictions,
    ...(userGuard.command_arg_restrictions ?? {}),
  };

  return {
    ...DEFAULT_CONFIG.guard,
    ...userGuard,
    command_arg_restrictions: mergedCommandArgRestrictions,
  };
}

const DEPRECATION_MSG =
  "[parism] guard.env_secret_patterns is deprecated; use guard.secrets.env_patterns. v2.0.0 제거 예정.";

/**
 * 지정된 경로에서 prism.config.json을 로드한다.
 * 파일이 없거나 파싱 실패 시 DEFAULT_CONFIG를 반환한다.
 *
 * 마이그레이션 shim:
 *   - 사용자가 guard.env_secret_patterns만 지정하면 guard.secrets.env_patterns에 복사하고 deprecation 경고를 출력한다.
 *   - 사용자가 guard.secrets.env_patterns만 지정하면 경고 없이 그대로 사용한다.
 *   - 둘 다 지정하면 guard.secrets.env_patterns를 우선하고 deprecation 경고를 출력한다.
 *   - 런타임에서 guard.env_secret_patterns는 항상 guard.secrets.env_patterns 값과 동일하게 유지되므로
 *     기존 소비자(buildRunResult 등)는 변경 없이 동작한다.
 */
export async function loadConfig(configPath: string): Promise<PrismConfig> {
  try {
    const raw      = await readFile(configPath, "utf-8");
    const json     = JSON.parse(raw) as Partial<PrismConfig>;
    const config: PrismConfig = {
      guard:    mergeGuardConfig(json.guard ?? {}),
      parsers: {
        ...DEFAULT_CONFIG.parsers,
        ...(json.parsers ?? {}),
      },
      telemetry: {
        ...DEFAULT_CONFIG.telemetry,
        ...(json.telemetry ?? {}),
      },
    };

    const userGuard        = json.guard as PartialPrismGuardConfig | undefined ?? {};
    const hasLegacy        = userGuard.env_secret_patterns !== undefined;
    const hasNew           = userGuard.secrets?.env_patterns !== undefined;

    if (hasLegacy || hasNew) {
      if (hasNew) {
        // 새 경로 우선; 레거시가 함께 있으면 경고 발생
        if (hasLegacy) process.stderr.write(DEPRECATION_MSG + "\n");
        const newPatterns                    = config.guard.secrets!.env_patterns!;
        config.guard.env_secret_patterns     = newPatterns;
      } else {
        // 레거시만 존재: 새 경로로 복사 + 경고
        process.stderr.write(DEPRECATION_MSG + "\n");
        const legacyPatterns             = config.guard.env_secret_patterns;
        config.guard.secrets             = {
          ...DEFAULT_CONFIG.guard.secrets,
          ...config.guard.secrets,
          env_patterns: legacyPatterns,
        };
      }
    }

    if (config.guard.allowed_paths.length === 0) {
      console.warn(
        "[parism] WARNING: allowed_paths is empty. " +
        "All filesystem paths are accessible. " +
        "Add paths to guard.allowed_paths in prism.config.json, or set [] to disable restriction.",
      );
    }

    return config;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      process.stderr.write(
        `[parism] WARNING: failed to load ${configPath}: ${(err as Error).message}\n`,
      );
    }
    return structuredClone(DEFAULT_CONFIG);
  }
}

/** 기본 allowed_paths. cwd가 루트(/)이면 홈 디렉터리로 제한하고 stderr에 경고한다. */
function defaultAllowedPaths(): string[] {
  const cwd = process.cwd();
  if (cwd !== "/") return [cwd];
  process.stderr.write(
    "[parism] WARNING: cwd is /; default allowed_paths is restricted to the home directory.\n",
  );
  return [os.homedir()];
}

function isWithin(child: string, root: string): boolean {
  const resolvedRoot  = path.resolve(root);
  const resolvedChild = path.resolve(child);
  return resolvedChild === resolvedRoot
    || resolvedChild.startsWith(resolvedRoot.endsWith(path.sep) ? resolvedRoot : resolvedRoot + path.sep);
}

/** 0은 무제한. 두 값 중 더 엄격한(작은 0 아닌) 값을 고르고, 둘 다 0일 때만 0이다. */
function narrowLimit(base: number, project: number | undefined): number {
  if (project === undefined || project === 0) return base;
  if (base === 0) return project;
  return Math.min(base, project);
}

/** 유한한 양수가 아닌 프로젝트 값은 무시한다. 기준값이 0(무제한)이면 유효한 프로젝트 값이 한도가 된다. */
function narrowTimeout(base: number, project: unknown): number {
  if (typeof project !== "number" || !Number.isFinite(project) || project <= 0) return base;
  return base === 0 ? project : Math.min(base, project);
}

function unionOf<T>(a: T[], b: T[] = []): T[] {
  return [...new Set([...a, ...b])];
}

function narrowAllowedPaths(base: string[], project: string[] | undefined): string[] {
  if (!project) return base;
  if (base.length === 0) return project;
  const kept = project.filter(p => base.some(root => isWithin(p, root)));
  if (kept.length < project.length) {
    process.stderr.write("[parism] WARNING: project allowed_paths outside the base paths were ignored.\n");
  }
  return kept.length > 0 ? kept : base;
}

function narrowArgRestrictions(
  base:    Record<string, CommandArgRestriction>,
  project: Record<string, CommandArgRestriction> = {},
): Record<string, CommandArgRestriction> {
  const result: Record<string, CommandArgRestriction> = { ...base };
  for (const [cmd, restriction] of Object.entries(project)) {
    result[cmd] = { blocked_flags: unionOf(base[cmd]?.blocked_flags ?? [], restriction.blocked_flags) };
  }
  return result;
}

/**
 * 프로젝트 설정 병합 규칙.
 * 전역 설정이 trust_project_config=true가 아니면 프로젝트 설정은 가드를 좁히기만 한다:
 * allowed_commands·allowed_paths는 교집합, timeout_ms·max_output_bytes는 더 엄격한 값,
 * block_patterns·command_arg_restrictions는 합집합, profile 등 그 외 키는 무시한다.
 */
function narrowGuard(base: PrismGuardConfig, project: PartialPrismGuardConfig): PrismGuardConfig {
  return {
    ...base,
    allowed_commands:         project.allowed_commands
      ? base.allowed_commands.filter(c => project.allowed_commands!.includes(c))
      : base.allowed_commands,
    allowed_paths:            narrowAllowedPaths(base.allowed_paths, project.allowed_paths),
    timeout_ms:               narrowTimeout(base.timeout_ms, project.timeout_ms),
    max_output_bytes:         narrowLimit(base.max_output_bytes, project.max_output_bytes),
    block_patterns:           unionOf(base.block_patterns, project.block_patterns),
    command_arg_restrictions: narrowArgRestrictions(base.command_arg_restrictions, project.command_arg_restrictions),
  };
}

/** 설정 파일을 JSON으로 읽는다. 없으면 undefined, 읽기·파싱 실패는 경고 후 undefined. */
async function readJsonLayer(filePath: string): Promise<Partial<PrismConfig> | undefined> {
  try {
    return JSON.parse(await readFile(filePath, "utf-8")) as Partial<PrismConfig>;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      process.stderr.write(
        `[parism] WARNING: failed to load ${filePath}: ${(err as Error).message}\n`,
      );
    }
    return undefined;
  }
}

/**
 * 원본 레이어 JSON의 레거시 키(guard.env_secret_patterns)를 신규 경로로 정규화한다.
 * 레거시 키가 있으면 경고하고, 신규 키가 없으면 값을 guard.secrets.env_patterns로 옮긴다.
 */
function normalizeLegacySecrets(layer: Partial<PrismConfig>): Partial<PrismConfig> {
  const guard = layer.guard as PartialPrismGuardConfig | undefined;
  if (guard?.env_secret_patterns === undefined) return layer;

  process.stderr.write(DEPRECATION_MSG + "\n");
  if (guard.secrets?.env_patterns !== undefined) return layer;

  return {
    ...layer,
    guard: {
      ...guard,
      secrets: { ...guard.secrets, env_patterns: guard.env_secret_patterns },
    } as PrismGuardConfig,
  };
}

/** 프로젝트 레이어의 상대 allowed_paths를 설정 파일 디렉터리 기준 절대경로로 바꾼다. */
function resolveProjectPaths(layer: Partial<PrismConfig>, projectPath: string): Partial<PrismConfig> {
  const guard = layer.guard as PartialPrismGuardConfig | undefined;
  if (!guard?.allowed_paths) return layer;

  const dir = path.dirname(path.resolve(projectPath));
  return {
    ...layer,
    guard: { ...guard, allowed_paths: guard.allowed_paths.map(p => path.resolve(dir, p)) } as PrismGuardConfig,
  };
}

export async function loadConfigMultiLayer(opts?: {
  globalPath?: string;
  projectPath?: string;
  envPrefix?: string;
}): Promise<PrismConfig> {
  const defaults = structuredClone(DEFAULT_CONFIG);
  defaults.guard.allowed_paths = defaultAllowedPaths();
  let config: PrismConfig = defaults;

  const globalPath = opts?.globalPath || path.join(os.homedir(), ".parism", "prism.config.json");
  const projectPath = opts?.projectPath || path.join(process.cwd(), "prism.config.json");
  const envPrefix = opts?.envPrefix || "PARISM_";

  const globalJson   = await readJsonLayer(globalPath);
  let   trustProject = false;
  if (globalJson) {
    trustProject = globalJson.trust_project_config === true;
    config       = mergeConfig(config, normalizeLegacySecrets(globalJson));
  }

  const projectJson = await readJsonLayer(projectPath);
  if (projectJson) {
    const layer = resolveProjectPaths(normalizeLegacySecrets(projectJson), projectPath);
    if (trustProject) {
      config = mergeConfig(config, layer);
    } else {
      config = {
        ...mergeConfig(config, { ...layer, guard: undefined }),
        guard: narrowGuard(config.guard, (layer.guard ?? {}) as PartialPrismGuardConfig),
      };
    }
  }

  config = mergeConfig(config, envToConfig(envPrefix));
  if (trustProject) config.trust_project_config = true;

  config.guard.env_secret_patterns = config.guard.secrets?.env_patterns ?? config.guard.env_secret_patterns;

  if (config.guard.allowed_paths.length === 0) {
    console.warn(
      "[parism] WARNING: allowed_paths is empty. " +
      "All filesystem paths are accessible. " +
      "Add paths to guard.allowed_paths in prism.config.json, or set [] to disable restriction.",
    );
  }

  return config;
}

/** 환경 변수의 음이 아닌 정수 값을 파싱한다. 유효하지 않으면 경고하고 undefined를 반환한다. */
function parseEnvInt(key: string, value: string | undefined): number | undefined {
  const n = value?.trim() ? Number(value) : NaN;
  if (Number.isFinite(n) && n >= 0) return n;
  process.stderr.write(`[parism] WARNING: invalid ${key}: ${JSON.stringify(value)}\n`);
  return undefined;
}

function envToConfig(envPrefix: string): Partial<PrismConfig> {
  const guard: Partial<PrismGuardConfig> = {};
  let parsers: PrismConfig["parsers"] | undefined;
  let telemetry: PrismConfig["telemetry"] | undefined;
  const prefix = envPrefix || "PARISM_";

  for (const [key, value] of Object.entries(process.env)) {
    if (!key.startsWith(prefix)) continue;
    const shortKey = key.slice(prefix.length).toLowerCase();

    if (shortKey === "allowed_commands") {
      guard.allowed_commands = value?.split(",").map(s => s.trim()).filter(Boolean) ?? [];
    } else if (shortKey === "allowed_paths") {
      guard.allowed_paths = value?.split(",").map(s => s.trim()).filter(Boolean) ?? [];
    } else if (shortKey === "timeout_ms") {
      const n = parseEnvInt(key, value);
      if (n !== undefined) guard.timeout_ms = n;
    } else if (shortKey === "max_output_bytes") {
      const n = parseEnvInt(key, value);
      if (n !== undefined) guard.max_output_bytes = n;
    } else if (shortKey === "max_items") {
      const n = parseEnvInt(key, value);
      if (n !== undefined) guard.max_items = n;
    } else if (shortKey === "default_page_size") {
      const n = parseEnvInt(key, value);
      if (n !== undefined) guard.default_page_size = n;
    } else if (shortKey === "strict_schemas") {
      parsers = parsers ?? {};
      parsers.strict_schemas = value === "true" || value === "1";
    } else if (shortKey === "telemetry_enabled") {
      telemetry = telemetry ?? {};
      telemetry.enabled = value === "true" || value === "1";
    } else if (shortKey.startsWith("adaptive_format_")) {
      const thresholdKey = shortKey.replace("adaptive_format_", "") as "json" | "compact" | "json_no_raw";
      const n            = parseEnvInt(key, value);
      if (n !== undefined) {
        parsers = parsers ?? {};
        parsers.adaptive_format_threshold = parsers.adaptive_format_threshold ?? {};
        parsers.adaptive_format_threshold[thresholdKey] = n;
      }
    }
  }

  const result: Partial<PrismConfig> = {};
  if (Object.keys(guard).length > 0) result.guard = guard as PrismGuardConfig;
  if (parsers) result.parsers = parsers;
  if (telemetry) result.telemetry = telemetry;
  return result;
}

function mergeConfig(base: PrismConfig, override: Partial<PrismConfig>): PrismConfig {
  return {
    guard: mergeGuardConfig({ ...base.guard, ...(override.guard ?? {}) }),
    parsers: {
      ...(base.parsers ?? {}),
      ...(override.parsers ?? {}),
    },
    telemetry: {
      ...(base.telemetry ?? {}),
      ...(override.telemetry ?? {}),
    },
  };
}
