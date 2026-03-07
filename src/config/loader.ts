import { readFile } from "node:fs/promises";

export interface CommandArgRestriction {
  blocked_flags: string[];
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
  env_secret_patterns:      string[];
}

export interface PrismConfig {
  guard: PrismGuardConfig;
}

type PartialPrismGuardConfig = Partial<PrismGuardConfig>;

export const DEFAULT_CONFIG: PrismConfig = {
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
    env_secret_patterns: [
      "TOKEN", "SECRET", "AUTHZ", "PASSWORD", "PASSWD", "CREDENTIAL",
    ],
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

/**
 * 지정된 경로에서 prism.config.json을 로드한다.
 * 파일이 없거나 파싱 실패 시 DEFAULT_CONFIG를 반환한다.
 */
export async function loadConfig(configPath: string): Promise<PrismConfig> {
  try {
    const raw  = await readFile(configPath, "utf-8");
    const json = JSON.parse(raw) as Partial<PrismConfig>;

    const config: PrismConfig = {
      guard: mergeGuardConfig(json.guard ?? {}),
    };

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
