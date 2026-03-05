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
    // path.resolve()로 ../를 포함한 모든 경로 순회 패턴을 정규화한 뒤 비교.
    // 단순 문자열 startsWith()는 /home/user/../../etc 형태로 우회 가능.
    const resolvedCwd = path.resolve(cwd);
    const normalizedCwd = resolvedCwd.endsWith("/") ? resolvedCwd : resolvedCwd + "/";
    const allowed = guard.allowed_paths.some((p) => {
      const resolvedP = path.resolve(p);
      const normalizedP = resolvedP.endsWith("/") ? resolvedP : resolvedP + "/";
      return normalizedCwd.startsWith(normalizedP);
    });

    if (!allowed) {
      throw new GuardError(
        `Working directory '${cwd}' is outside allowed paths`,
        "path_not_allowed",
      );
    }
  }
}
