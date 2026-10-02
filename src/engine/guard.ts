import path from "path";
import { lstatSync, realpathSync } from "node:fs";
import {
  BUILD_PROFILE_POLICIES, effectiveFlags, flagKind, hasPolicy, policySource, resolvePolicies, tokenizeArgs,
  tokenizePolicyless, type CommandPolicy, type ParsedArg, type PolicySource,
} from "./policy.js";
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
 * 경로를 절대경로로 만든 뒤 존재하는 가장 가까운 상위 경로까지 심볼릭 링크를 해석한 실경로를 돌려준다.
 */
export function realPathOf(inputPath: string): string {
  return resolveRealUncached(path.resolve(inputPath));
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
 * 명령 실행 허용 여부를 검사한다. 차단 조건 충족 시 GuardError를 던진다.
 *
 * 검사 순서:
 * 1. 화이트리스트: cmd가 allowed_commands에 없으면 차단
 * 2. 인젝션 패턴: args 중 block_patterns에 포함된 패턴이 있으면 차단
 * 3. 명령별 인자 제한: command_arg_restrictions에 등록된 blocked_flags와 일치하면 차단
 * 4. 명령 정책: 유효 정책이 있는 명령은 서브커맨드·플래그·위치 인자를 허용목록으로 검사
 * 5. 경로 제한: allowed_paths가 설정된 경우 cwd와 경로 후보(collectPathCandidates)가 허용 경로 하위인지 확인(심볼릭 링크 해석)
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

  const restrictions = guard.command_arg_restrictions;
  const restriction  = restrictions && Object.hasOwn(restrictions, cmd) ? restrictions[cmd] : undefined;
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
  if (!policy && hasPolicy(BUILD_PROFILE_POLICIES, cmd)) {
    throw new GuardError(
      `Command '${cmd}' requires the build profile`,
      "command_not_allowed",
    );
  }
  const operands = policy
    ? checkPolicy(cmd, args, policy, policySource(guard, cmd) ?? "default")
    : { tokens: tokenizePolicyless(args), view: undefined };

  if (guard.allowed_paths.length > 0) {
    const resolvedCwd = path.resolve(cwd);

    if (!isAllowedPath(resolvedCwd, guard.allowed_paths)) {
      throw new GuardError(
        `Working directory '${cwd}' is outside allowed paths. ` +
        "Add guard.allowed_paths in prism.config.json or set [] to disable.",
        "path_not_allowed",
      );
    }

    const candidates = new Set(collectPathCandidates(operands.tokens, operands.view, cwd));

    for (const arg of candidates) {
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

/** 정책 검사를 통과한 인자: 경로 후보를 고를 토큰과 서브커맨드에 맞춘 유효 정책 */
interface PolicyOperands {
  tokens: ParsedArg[];
  view:   CommandPolicy | undefined;
}

/**
 * 정책 허용목록 검사. 통과 시 경로 후보를 고를 토큰(앞 전역 플래그, 서브커맨드, 하위 동사 제외)과
 * 서브커맨드의 플래그 종류·위치 인자 규칙을 반영한 유효 정책을 반환한다.
 * subVerbs가 지정된 서브커맨드는 첫 위치 인자를 하위 동사 허용목록으로 검사한다.
 */
function checkPolicy(cmd: string, args: string[], policy: CommandPolicy, source: PolicySource): PolicyOperands {
  let lead = 0;
  while (policy.leadingFlags?.includes(args[lead] ?? "")) lead++;
  let rest = args.slice(lead);
  let sub: string | undefined;
  if (policy.subcommands) {
    sub = rest[0];
    if (sub === undefined || !policy.subcommands.includes(sub)) deny(cmd, sub ?? "(none)", source);
    rest = rest.slice(1);
  }
  const operands: ParsedArg[] = [];
  const positionalMode  = (sub !== undefined ? policy.subPositionals?.[sub] : undefined) ?? policy.positionals;
  const flags           = effectiveFlags(policy, sub);
  const tokens          = tokenizeArgs(rest, flags, policy.singleDashLong, {
    numericFlag:      policy.numericFlag,
    stopAtPositional: policy.stopAtPositional,
  });
  const verbs           = sub !== undefined ? policy.subVerbs?.[sub] : undefined;
  let   verbChecked     = verbs === undefined;

  for (const t of tokens) {
    if (t.passthrough) {
      operands.push(t);
      continue;
    }
    if (t.kind === "flag") {
      const kind = flagKind(flags, t.name);
      if (!kind && !(policy.numericFlag && /^-[0-9]+$/.test(t.name))) deny(cmd, t.name, source);
      if (t.value?.startsWith("@") && policy.fileRefFlags?.includes(t.name)) deny(cmd, `${t.name} ${t.value}`, source);
      if (t.value !== undefined && policy.deniedValues?.[t.name]?.some(d => t.value!.includes(d))) deny(cmd, `${t.name} ${t.value}`, source);
      if (t.value !== undefined && !isAllowedValue(policy, t.name, t.value)) deny(cmd, `${t.name} ${t.value}`, source);
      operands.push(t);
      continue;
    }
    if (!verbChecked) {
      if (!verbs!.includes(t.name)) deny(cmd, t.name, source);
      verbChecked = true;
      continue;
    }
    if (positionalMode === "none") deny(cmd, t.name, source);
    if (positionalMode === "url" && !/^https?:\/\//i.test(t.name)) deny(cmd, t.name, source);
    operands.push(t);
  }
  if (!verbChecked) deny(cmd, "(missing verb)", source);
  return { tokens: operands, view: { ...policy, flags, positionals: positionalMode } };
}

/**
 * 정책의 allowedValues에 플래그 항목이 있으면 값이 목록에 맞는지 검사한다. 항목이 없으면 허용한다.
 * "="로 끝나는 목록 항목은 접두사로, 나머지는 같은 값으로 비교한다.
 */
function isAllowedValue(policy: CommandPolicy, name: string, value: string): boolean {
  if (!policy.allowedValues || !Object.hasOwn(policy.allowedValues, name)) return true;
  return policy.allowedValues[name]!.some(v => (v.endsWith("=") ? value.startsWith(v) : value === v));
}

/**
 * 경로로 해석될 수 있는 플래그 부착 값인지 판단한다.
 */
function isPathLikeValue(value: string): boolean {
  return value.includes("/") || value.startsWith("~") || value.startsWith(".");
}

/**
 * cwd 기준으로 해석한 경로에 파일 시스템 항목(심볼릭 링크 포함)이 있는지 확인한다.
 * 경로로 쓸 수 없는 값(널 문자, 지나치게 긴 이름, 파일 아래 경로)은 항목이 없는 것으로 본다.
 */
function existsUnder(cwd: string, value: string): boolean {
  if (value.length === 0 || value.includes("\0")) return false;
  try {
    return lstatSync(path.resolve(cwd, value), { throwIfNoEntry: false }) !== undefined;
  } catch {
    return false;
  }
}

/**
 * 경로 검사를 받을 인자를 모은다. 정책이 있는 명령과 없는 명령이 같은 규칙을 쓴다.
 * - path 종류 플래그의 값과, 위치 인자 규칙이 path인 위치 인자는 형식과 관계없이 모은다.
 * - 그 밖의 위치 인자와 플래그 값은 `/`를 포함하거나 `.`, `~`로 시작하거나
 *   cwd 기준으로 존재하는 항목(심볼릭 링크 포함)을 가리키면 모은다.
 * - stopAtPositional 이후 대상 프로그램 몫으로 넘긴 인자는 tokenizePolicyless로 분해해 같은 규칙을 적용한다.
 * policy는 서브커맨드의 플래그 종류와 위치 인자 규칙을 반영한 유효 정책이며, 정책 없는 명령은 undefined다.
 */
export function collectPathCandidates(tokens: ParsedArg[], policy: CommandPolicy | undefined, cwd: string): string[] {
  const isPathArg   = (v: string): boolean => isPathLikeValue(v) || existsUnder(cwd, v);
  const out:         string[] = [];
  const passthrough: string[] = [];

  for (const t of tokens) {
    if (t.passthrough) {
      passthrough.push(t.name);
      continue;
    }
    if (t.kind === "flag") {
      if (!t.value) continue;
      const isPathFlag = policy !== undefined && flagKind(policy.flags, t.name) === "path";
      if (isPathFlag || isPathArg(t.value)) out.push(t.value);
      continue;
    }
    if (policy?.positionals === "path" || isPathArg(t.name)) out.push(t.name);
  }
  if (passthrough.length > 0) out.push(...collectPathCandidates(tokenizePolicyless(passthrough), undefined, cwd));
  return out;
}
