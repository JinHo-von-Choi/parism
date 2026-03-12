import path from "path";
import type { PrismConfig } from "../config/loader.js";

/**
 * Execution Guard가 차단 시 던지는 오류.
 */
export class GuardError extends Error {
  constructor(
    message: string,
    public readonly reason:
      | "command_not_allowed"
      | "path_not_allowed"
      | "injection_pattern"
      | "arg_not_allowed",
  ) {
    super(message);
    this.name = "GuardError";
  }
}

/**
 * 경로 비교 시 접미 슬래시를 강제해 `/home/user` vs `/home/user2` 오탐을 방지한다.
 */
function normalizePathForPrefix(inputPath: string): string {
  const resolved = path.resolve(inputPath);
  return resolved.endsWith("/") ? resolved : resolved + "/";
}

/**
 * 대상 경로가 허용 경로 집합 중 하나의 하위 경로인지 검사한다.
 */
function isAllowedPath(targetPath: string, allowedPaths: string[]): boolean {
  const normalizedTarget = normalizePathForPrefix(targetPath);
  return allowedPaths.some((allowedPath) => {
    const normalizedAllowed = normalizePathForPrefix(allowedPath);
    return normalizedTarget.startsWith(normalizedAllowed);
  });
}

/**
 * 명령 인자 중 `/`, `./`, `../`로 시작하는 경로형 인자만 추출한다.
 */
function getPathLikeArgs(args: string[]): string[] {
  return args.filter((arg) =>
    arg.startsWith("/") ||
    arg.startsWith("./") ||
    arg.startsWith("../")
  );
}

/**
 * 경로 인자를 받는 명령. 플래그가 아닌(positional) 인자를 경로 후보로 검사한다.
 * find src, cat subdir/file, ls -la dir 등 상대경로(슬래시 없음)도 검사 대상.
 */
const PATH_TAKING_COMMANDS = new Set([
  "cat", "find", "stat", "du", "tree", "head", "tail", "ls", "grep", "wc",
]);

/**
 * 명령별로 경로로 해석되는 인자들을 수집한다.
 * PATH_TAKING_COMMANDS에 있는 명령은 플래그로 시작하지 않는 인자를 경로 후보로 본다.
 */
function getPathArgsFromCommand(cmd: string, args: string[]): string[] {
  if (!PATH_TAKING_COMMANDS.has(cmd)) return [];
  return args.filter((arg) => arg !== "-" && !arg.startsWith("-"));
}

/**
 * 명령 실행 허용 여부를 검사한다. 차단 조건 충족 시 GuardError를 던진다.
 *
 * 검사 순서:
 * 1. 화이트리스트 — cmd가 allowed_commands에 없으면 차단
 * 2. 인젝션 패턴 — args 중 block_patterns에 포함된 패턴이 있으면 차단
 * 3. 명령별 인자 제한 — command_arg_restrictions에 등록된 blocked_flags와 일치하면 차단
 * 4. 경로 제한 — allowed_paths가 설정된 경우 cwd가 허용 경로 하위인지 확인
 */
export function checkGuard(
  cmd:    string,
  args:   string[],
  cwd:    string,
  config: PrismConfig,
): void {
  const { guard } = config;

  if (!guard.allowed_commands.includes(cmd)) {
    throw new GuardError(
      `Command '${cmd}' is not in the allowed list`,
      "command_not_allowed",
    );
  }

  const allArgs = args.join(" ");
  for (const pattern of guard.block_patterns) {
    if (allArgs.includes(pattern)) {
      throw new GuardError(
        `Blocked pattern '${pattern}' detected in arguments`,
        "injection_pattern",
      );
    }
  }

  const restriction = guard.command_arg_restrictions?.[cmd];
  if (restriction) {
    for (const arg of args) {
      // --flag=value 형태에서 플래그 이름만 추출
      const normalized = arg.startsWith("--") ? arg.split("=")[0]! : arg;
      if (restriction.blocked_flags.includes(normalized)) {
        throw new GuardError(
          `Argument '${arg}' is not allowed for command '${cmd}'`,
          "arg_not_allowed",
        );
      }
    }
  }

  if (guard.allowed_paths.length > 0) {
    const resolvedCwd = path.resolve(cwd);

    if (!isAllowedPath(resolvedCwd, guard.allowed_paths)) {
      throw new GuardError(
        `Working directory '${cwd}' is outside allowed paths. ` +
        "Add guard.allowed_paths in prism.config.json or set [] to disable.",
        "path_not_allowed",
      );
    }

    const pathLikeArgs   = getPathLikeArgs(args);
    const pathArgsByCmd  = getPathArgsFromCommand(cmd, args);
    const allPathArgs    = [...new Set([...pathLikeArgs, ...pathArgsByCmd])];

    for (const arg of allPathArgs) {
      const resolvedArgPath = path.resolve(cwd, arg);
      if (!isAllowedPath(resolvedArgPath, guard.allowed_paths)) {
        throw new GuardError(
          `Path argument '${arg}' resolves outside allowed paths. ` +
          "Add guard.allowed_paths in prism.config.json or set [] to disable.",
          "path_not_allowed",
        );
      }
    }
  }
}
