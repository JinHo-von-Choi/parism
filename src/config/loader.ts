import { readFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import type { CommandPolicy } from "../engine/policy.js";
import { realPathOf } from "../engine/guard.js";
import { LIMIT_SCHEMA, validateConfigLayer } from "./schema.js";

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
  max_page_size:            number;   // run_paged page_size 상한(줄 수). 넘는 요청은 이 값으로 줄인다
  max_concurrency:          number;   // 동시에 실행하는 자식 프로세스 수 상한. 넘는 요청은 대기한다
  block_patterns:           string[];
  command_arg_restrictions: Record<string, CommandArgRestriction>;
  command_policies?:        Record<string, CommandPolicy>;
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
      "ping", "curl", "netstat", "lsof", "ss", "dig",
      "grep", "wc", "head", "tail", "cat",
      "git",
      "env", "pwd", "which",
      "echo", "date", "uname", "hostname",
      "free", "id",
      "kubectl", "docker", "gh",
      "systemctl", "journalctl",
      "helm", "terraform", "apt", "brew",
      "npm", "pnpm", "cargo",
    ],
    allowed_paths:    [process.cwd()],
    timeout_ms:       10000,
    max_output_bytes:  102400,   // 100 KB
    max_items:         500,
    default_page_size: 100,
    max_page_size:     1000,
    max_concurrency:   4,
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
 * default_page_size는 max_page_size를 넘지 않게 줄인다.
 */
function mergeGuardConfig(userGuard: PartialPrismGuardConfig): PrismGuardConfig {
  const mergedCommandArgRestrictions = {
    ...DEFAULT_CONFIG.guard.command_arg_restrictions,
    ...(userGuard.command_arg_restrictions ?? {}),
  };
  const merged = { ...DEFAULT_CONFIG.guard, ...userGuard };

  return {
    ...merged,
    command_arg_restrictions: mergedCommandArgRestrictions,
    default_page_size:        Math.min(merged.default_page_size, merged.max_page_size),
  };
}

const REMOVED_KEY_MSG =
  "[parism] guard.env_secret_patterns was removed in 2.0.0 and is ignored; use guard.secrets.env_patterns.";

/**
 * 설정 파일 JSON을 레이어로 바꾼다.
 * 제거된 레거시 키(guard.env_secret_patterns)는 전용 경고를 내고, 나머지 필드는 스키마로 검증한다.
 * 검증은 알 수 없는 키를 버리므로 레거시 키도 결과에 남지 않는다.
 */
function toLayer(json: unknown, source: string): Partial<PrismConfig> {
  const guard = (json as { guard?: unknown } | null | undefined)?.guard;
  if (typeof guard === "object" && guard !== null && "env_secret_patterns" in guard) {
    process.stderr.write(REMOVED_KEY_MSG + "\n");
  }
  return validateConfigLayer(json, source);
}

/** 기본 설정 사본. allowed_paths는 실행 디렉터리 규칙(defaultAllowedPaths)을 따른다. */
function baseConfig(): PrismConfig {
  const defaults = structuredClone(DEFAULT_CONFIG);
  defaults.guard.allowed_paths = defaultAllowedPaths();
  return defaults;
}

function warnIfPathsUnrestricted(config: PrismConfig): void {
  if (config.guard.allowed_paths.length > 0) return;
  console.warn(
    "[parism] WARNING: allowed_paths is empty. " +
    "All filesystem paths are accessible. " +
    "Add paths to guard.allowed_paths in prism.config.json, or set [] to disable restriction.",
  );
}

/**
 * 지정된 경로에서 prism.config.json을 로드한다.
 * 파일이 없거나 파싱 실패 시 기본 설정을 반환한다. 무효 필드는 경고 후 기본값을 유지한다.
 */
export async function loadConfig(configPath: string): Promise<PrismConfig> {
  const json   = await readJsonLayer(configPath);
  const config = json === undefined ? baseConfig() : mergeConfig(baseConfig(), toLayer(json, configPath));
  if (json !== undefined) warnIfPathsUnrestricted(config);
  return config;
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

/**
 * 프로젝트 allowed_paths 중 기준 경로 안에 있는 항목만 남긴다.
 * 비교와 저장은 심볼릭 링크를 해석한 실경로로 한다. 저장소 안의 링크가 기준 경로 밖을 가리키면 버린다.
 * 남는 항목이 없으면 기준 경로를 유지한다.
 */
function narrowAllowedPaths(base: string[], project: string[] | undefined): string[] {
  if (!project) return base;
  if (base.length === 0) return project;
  const roots = base.map(realPathOf);
  const kept  = project.map(realPathOf).filter(p => roots.some(root => isWithin(p, root)));
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
 * block_patterns·command_arg_restrictions는 합집합, profile·command_policies 등 그 외 키는 무시한다.
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
async function readJsonLayer(filePath: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(filePath, "utf-8")) as unknown;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      process.stderr.write(
        `[parism] WARNING: failed to load ${filePath}: ${(err as Error).message}\n`,
      );
    }
    return undefined;
  }
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
  let config: PrismConfig = baseConfig();

  const globalPath = opts?.globalPath || path.join(os.homedir(), ".parism", "prism.config.json");
  const projectPath = opts?.projectPath || path.join(process.cwd(), "prism.config.json");
  const envPrefix = opts?.envPrefix || "PARISM_";

  const globalJson   = await readJsonLayer(globalPath);
  let   trustProject = false;
  if (globalJson !== undefined) {
    const layer  = toLayer(globalJson, globalPath);
    trustProject = layer.trust_project_config === true;
    config       = mergeConfig(config, layer);
  }

  const projectJson = await readJsonLayer(projectPath);
  if (projectJson !== undefined) {
    const layer = resolveProjectPaths(toLayer(projectJson, projectPath), projectPath);
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

  warnIfPathsUnrestricted(config);
  return config;
}

/** 환경 변수의 유한한 0 이상 정수 값을 파싱한다. 유효하지 않으면 경고하고 undefined를 반환한다. */
function parseEnvInt(key: string, value: string | undefined): number | undefined {
  const n = value?.trim() ? Number(value) : NaN;
  if (LIMIT_SCHEMA.safeParse(n).success) return n;
  process.stderr.write(`[parism] WARNING: invalid ${key}: ${JSON.stringify(value)}\n`);
  return undefined;
}

/** 쉼표 구분 목록을 파싱한다. 항목이 하나도 없으면 경고하고 undefined를 반환한다. */
function parseEnvList(key: string, value: string | undefined): string[] | undefined {
  const list = value?.split(",").map(s => s.trim()).filter(Boolean) ?? [];
  if (list.length > 0) return list;
  process.stderr.write(`[parism] WARNING: ignored empty ${key}\n`);
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
      const list = parseEnvList(key, value);
      if (list !== undefined) guard.allowed_commands = list;
    } else if (shortKey === "allowed_paths") {
      const list = parseEnvList(key, value);
      if (list !== undefined) guard.allowed_paths = list;
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

/**
 * 상위 레이어를 기준 설정 위에 병합한다.
 * command_policies는 명령 단위로, secrets와 adaptive_format_threshold는 하위 키 단위로 병합해
 * 상위 레이어가 지정하지 않은(또는 검증에서 버려진) 하위 값은 기준값을 유지한다.
 */
function mergeConfig(base: PrismConfig, override: Partial<PrismConfig>): PrismConfig {
  const guard: PartialPrismGuardConfig = { ...base.guard, ...(override.guard ?? {}) };
  if (base.guard.command_policies && override.guard?.command_policies) {
    guard.command_policies = { ...base.guard.command_policies, ...override.guard.command_policies };
  }
  if (base.guard.secrets && override.guard?.secrets) {
    guard.secrets = { ...base.guard.secrets, ...override.guard.secrets };
  }
  const parsers: PrismParsersConfig = { ...(base.parsers ?? {}), ...(override.parsers ?? {}) };
  if (base.parsers?.adaptive_format_threshold && override.parsers?.adaptive_format_threshold) {
    parsers.adaptive_format_threshold = {
      ...base.parsers.adaptive_format_threshold,
      ...override.parsers.adaptive_format_threshold,
    };
  }
  return {
    guard: mergeGuardConfig(guard),
    parsers,
    telemetry: {
      ...(base.telemetry ?? {}),
      ...(override.telemetry ?? {}),
    },
  };
}
