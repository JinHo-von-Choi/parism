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

export const DEFAULT_CONFIG: PrismConfig = {
  guard: {
    allowed_commands: [
      "ls", "find", "stat", "du", "df", "tree",
      "ps", "kill",
      "ping", "curl", "netstat",
      "grep", "wc", "head", "tail", "cat",
      "git",
      "env", "pwd", "which",
      "echo", "date", "uname", "hostname",
    ],
    allowed_paths:    [],
    timeout_ms:       10000,
    max_output_bytes:  102400,   // 100 KB
    max_items:         500,
    default_page_size: 100,
    block_patterns: [";", "$(", "`", "&&", "||", ">", ">>", "<", "|"],
    command_arg_restrictions: {
      node: { blocked_flags: ["-e", "--eval", "-r", "--require", "-p", "--print", "--input-type"] },
      npx:  { blocked_flags: ["--yes", "-y"] },
    },
    env_secret_patterns: [
      "TOKEN", "SECRET", "AUTHZ", "PASSWORD", "PASSWD", "CREDENTIAL",
    ],
  },
};

/**
 * 지정된 경로에서 prism.config.json을 로드한다.
 * 파일이 없거나 파싱 실패 시 DEFAULT_CONFIG를 반환한다.
 */
export async function loadConfig(configPath: string): Promise<PrismConfig> {
  try {
    const raw  = await readFile(configPath, "utf-8");
    const json = JSON.parse(raw) as Partial<PrismConfig>;

    return {
      guard: { ...DEFAULT_CONFIG.guard, ...(json.guard ?? {}) },
    };
  } catch {
    return DEFAULT_CONFIG;
  }
}
