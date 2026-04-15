import { readFile } from "node:fs/promises";

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
  /** @deprecated guard.secrets.env_patterns 으로 이전하세요. v0.7.0 제거 예정. */
  env_secret_patterns:      string[];
  secrets?:                 PrismGuardSecretsConfig;
}

export interface PrismParsersConfig {
  strict_schemas?: boolean;
}

export interface PrismConfig {
  guard:    PrismGuardConfig;
  parsers?: PrismParsersConfig;
}

type PartialPrismGuardConfig = Partial<PrismGuardConfig>;

const DEFAULT_ENV_SECRET_PATTERNS = [
  "TOKEN", "SECRET", "AUTHZ", "PASSWORD", "PASSWD", "CREDENTIAL",
];

export const DEFAULT_CONFIG: PrismConfig = {
  parsers: {
    strict_schemas: false,
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
  "[parism] guard.env_secret_patterns is deprecated; use guard.secrets.env_patterns. v0.7.0 제거 예정.";

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
  } catch {
    return DEFAULT_CONFIG;
  }
}
