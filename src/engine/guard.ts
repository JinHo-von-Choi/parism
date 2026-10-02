import path from "path";
import { realpathSync } from "node:fs";
import { BUILD_PROFILE_POLICIES, policySource, resolvePolicies, tokenizeArgs, type CommandPolicy, type PolicySource } from "./policy.js";
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
function normalizePathForPrefix(inputPath: string, cacheable = false): string {
  const abs      = path.resolve(inputPath);
  const resolved = cacheable ? resolveReal(abs) : resolveRealUncached(abs);
  return resolved.endsWith("/") ? resolved : resolved + "/";
}

/**
 * 존재하는 가장 가까운 상위 경로까지 심볼릭 링크를 해석하고 나머지 경로를 덧붙인다.
 */
const realCache = new Map<string, string>();

function resolveReal(absPath: string): string {
  const hit = realCache.get(absPath);
  if (hit !== undefined) return hit;
  const r = resolveRealUncached(absPath);
  if (realCache.size > 1024) realCache.clear();
  realCache.set(absPath, r);
  return r;
}

function resolveRealUncached(absPath: string): string {
  let head = absPath;
  const tail: string[] = [];
  for (;;) {
    try {
      return path.join(realpathSync.native(head), ...tail.reverse());
    } catch {
      const parent = path.dirname(head);
      if (parent === head) return absPath;
      tail.push(path.basename(head));
      head = parent;
    }
  }
}

/**
 * 대상 경로가 허용 경로 집합 중 하나의 하위 경로인지 검사한다.
 */
function isAllowedPath(targetPath: string, allowedPaths: string[]): boolean {
  const normalizedTarget = normalizePathForPrefix(targetPath);
  return allowedPaths.some((allowedPath) => {
    const normalizedAllowed = normalizePathForPrefix(allowedPath, true);
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
  "git", "docker", "kubectl", "cargo", "node", "npx", "npm",
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
 * 1. 화이트리스트: cmd가 allowed_commands에 없으면 차단
 * 2. 인젝션 패턴: args 중 block_patterns에 포함된 패턴이 있으면 차단
 * 3. 명령별 인자 제한: command_arg_restrictions에 등록된 blocked_flags와 일치하면 차단
 * 4. 명령 정책: 유효 정책이 있는 명령은 서브커맨드·플래그·위치 인자를 허용목록으로 검사
 * 5. 경로 제한: allowed_paths가 설정된 경우 cwd와 경로 인자가 허용 경로 하위인지 확인(심볼릭 링크 해석)
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

  for (const pattern of guard.block_patterns) {
    for (const arg of args) {
      if (arg.includes(pattern)) {
        throw new GuardError(
          `Blocked pattern '${pattern}' detected in argument '${arg}'`,
          "injection_pattern",
        );
      }
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

  const policy      = resolvePolicies(guard)[cmd];
  if (!policy && BUILD_PROFILE_POLICIES[cmd]) {
    throw new GuardError(
      `Command '${cmd}' requires the build profile`,
      "command_not_allowed",
    );
  }
  const policyPaths = policy
    ? checkPolicy(cmd, args, policy, policySource(guard, cmd) ?? "default")
    : attachedFlagPaths(args);

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
    const allPathArgs    = [...new Set([...pathLikeArgs, ...pathArgsByCmd, ...policyPaths])];

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

function deny(cmd: string, arg: string, source: PolicySource): never {
  throw new GuardError(
    `Argument '${arg}' is not allowed for command '${cmd}' (policy: ${source})`,
    "arg_not_allowed",
  );
}

/**
 * 정책 허용목록 검사. 통과 시 경로 검사 대상 인자 목록을 반환한다.
 * subVerbs가 지정된 서브커맨드는 첫 위치 인자를 하위 동사 허용목록으로 검사한다.
 */
function checkPolicy(cmd: string, args: string[], policy: CommandPolicy, source: PolicySource): string[] {
  let lead = 0;
  while (policy.leadingFlags?.includes(args[lead] ?? "")) lead++;
  let rest = args.slice(lead);
  let sub: string | undefined;
  if (policy.subcommands) {
    sub = rest[0];
    if (sub === undefined || !policy.subcommands.includes(sub)) deny(cmd, sub ?? "(none)", source);
    rest = rest.slice(1);
  }
  const paths: string[] = [];
  const positionalMode  = (sub && policy.subPositionals?.[sub]) ?? policy.positionals;
  const tokens          = tokenizeArgs(rest, policy.flags, policy.singleDashLong, {
    numericFlag:      policy.numericFlag,
    stopAtPositional: policy.stopAtPositional,
  });
  const verbs           = sub !== undefined ? policy.subVerbs?.[sub] : undefined;
  let   verbChecked     = verbs === undefined;

  for (const t of tokens) {
    if (t.passthrough) continue;
    if (t.kind === "flag") {
      const kind = policy.flags[t.name];
      if (!kind && !(policy.numericFlag && /^-[0-9]+$/.test(t.name))) deny(cmd, t.name, source);
      if (t.value?.startsWith("@") && policy.fileRefFlags?.includes(t.name)) deny(cmd, `${t.name} ${t.value}`, source);
      if (t.value !== undefined && policy.deniedValues?.[t.name]?.some(d => t.value!.includes(d))) deny(cmd, `${t.name} ${t.value}`, source);
      if (kind === "path" && t.value) paths.push(t.value);
      continue;
    }
    if (!verbChecked) {
      if (!verbs!.includes(t.name)) deny(cmd, t.name, source);
      verbChecked = true;
      continue;
    }
    if (positionalMode === "none") deny(cmd, t.name, source);
    if (positionalMode === "url" && !/^https?:\/\//i.test(t.name)) deny(cmd, t.name, source);
    if (positionalMode === "path") paths.push(t.name);
  }
  if (!verbChecked) deny(cmd, "(missing verb)", source);
  return paths;
}

/**
 * 경로로 해석될 수 있는 플래그 부착 값인지 판단한다.
 */
function isPathLikeValue(value: string): boolean {
  return value.includes("/") || value.startsWith("~") || value.startsWith(".");
}

/**
 * 정책이 없는 명령에서 플래그에 붙은 경로형 값을 추출한다.
 * --x=value는 value를, 짧은 플래그 묶음(-abVALUE)은 어느 글자가 값을 받는지 알 수 없으므로
 * 플래그 글자로 볼 수 있는 각 문자 뒤의 나머지 문자열 중 경로형인 것을 모두 검사 대상으로 삼는다.
 */
function attachedFlagPaths(args: string[]): string[] {
  const out: string[] = [];
  for (const a of args) {
    if (!a.startsWith("-") || a === "-" || a === "--") continue;
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      if (eq >= 0 && isPathLikeValue(a.slice(eq + 1))) out.push(a.slice(eq + 1));
      continue;
    }
    for (let j = 2; j < a.length && /[A-Za-z0-9]/.test(a[j - 1]!); j++) {
      const suffix = a.slice(j);
      if (isPathLikeValue(suffix)) out.push(suffix);
    }
  }
  return out;
}
