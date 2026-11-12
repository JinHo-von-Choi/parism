import path from "path";
import { lstatSync, realpathSync, statSync } from "node:fs";
import { realPathOf, resolveRealUncached } from "../utils/fs-path.js";
import {
  BUILD_PROFILE_POLICIES, DEFAULT_POLICIES, effectiveFlags, flagKind, hasPolicy, isBuildProfile, policySource, resolvePolicies, tokenizeArgs,
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

/**
 * 경로를 절대경로로 만든 뒤 존재하는 가장 가까운 상위 경로까지 심볼릭 링크를 해석한 실경로를 돌려준다.
 * 구현은 src/utils/fs-path.ts에 있다. 기존 import 경로를 위해 여기서 다시 내보낸다.
 */
export { realPathOf };

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
 * 4. 명령 정책: 유효 정책이 있는 명령은 서브커맨드·플래그·위치 인자를 허용목록으로 검사.
 *    기본 정책이나 build 프로필 정책을 쓰는 기본 명령은 인자가 `--version` 하나뿐이면 정책 검사를 생략한다.
 * 5. 경로 제한: allowed_paths가 설정된 경우 cwd와 경로 후보(collectPathCandidates)가 허용 경로 하위인지 확인(심볼릭 링크 해석)
 */
/**
 * cmd에 명령줄 전체("git status")가 들어온 경우의 안내문.
 * 첫 낱말이 허용된 명령일 때만 안내한다. 그 밖에는 빈 문자열을 돌려준다.
 */
function commandLineHint(cmd: string, allowed: string[]): string {
  const [name, ...rest] = cmd.trim().split(/\s+/);
  if (!name || name === cmd || !allowed.includes(name)) return "";
  /** 따옴표가 있으면 공백으로 나눈 결과가 실제 인자와 달라서 예시를 붙이지 않는다. */
  const splittable = rest.length > 0 && rest.length <= 8 && !/["'\\]/.test(cmd);
  const example    = splittable ? `, args: ${JSON.stringify(rest)}` : "";
  return `. cmd takes the executable name only. Pass arguments in args, one per element (cmd: "${name}"${example})`;
}

/**
 * 인터프리터가 직접 실행하는 인라인 코드 인자의 플래그. 이 인자는 셸이 아니라 인터프리터가 해석하므로
 * 코드 안의 `;`, `|`, `>`는 셸 연산자가 아니다. 인터프리터를 쓸 수 있는지는 allowed_commands와 정책이 따로 판정한다.
 */
const INLINE_CODE_FLAGS: Readonly<Record<string, readonly string[]>> = {
  python:  ["-c"],
  python3: ["-c"],
  node:    ["-e", "--eval", "-p", "--print"],
  ruby:    ["-e"],
  perl:    ["-e", "-E"],
};

/**
 * 데이터베이스 클라이언트가 직접 실행하는 SQL 인자의 플래그. 플래그 값 위치와 관계없이 어디에 와도 SQL이다.
 * sqlite3은 플래그 대신 데이터베이스 파일 다음의 위치 인자가 SQL이다(`sqlite3 app.db "select 1; select 2;"`).
 */
const SQL_FLAGS: Readonly<Record<string, readonly string[]>> = {
  psql:    ["-c", "--command"],
  mysql:   ["-e", "--execute"],
  sqlite3: ["-cmd"],
};

/** sqlite3의 SQL 위치 인자(데이터베이스 파일 다음의 위치 인자). 값을 받는 옵션의 값은 위치 인자로 세지 않는다. */
const SQLITE_VALUE_OPTIONS = new Set(["-cmd", "-separator", "-newline", "-nullvalue", "-init", "-vfs", "-maxsize", "-mmap", "-pagecache", "-lookaside", "-heap"]);

/**
 * pip 요구 사항 지정자(`"cython>=3.1"`, `"pkg[extra]<2,!=1.5"`). 비교 연산자의 `>`, `<`는 셸 연산자가 아니라 버전 조건이다.
 * pip, pip3, `python -m pip`의 install·download·wheel 뒤 위치 인자 가운데 이 형식인 것만 뺀다.
 */
const REQUIREMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*(\[[A-Za-z0-9._,-]+\])?\s*(===|==|>=|<=|~=|!=|>|<)\s*[A-Za-z0-9.*+!_-]+(\s*,\s*(===|==|>=|<=|~=|!=|>|<)\s*[A-Za-z0-9.*+!_-]+)*$/;
const PIP_INSTALL_VERBS = new Set(["install", "download", "wheel"]);

function requirementArguments(name: string, args: readonly string[], text: Set<number>): void {
  let start = -1;
  if (name === "pip" || name === "pip3") start = 0;
  else if (/^python\d?$/.test(name)) {
    const m = args.indexOf("-m");
    if (m >= 0 && args[m + 1] === "pip") start = m + 2;
  }
  if (start < 0 || !PIP_INSTALL_VERBS.has(args[start] ?? "")) return;
  for (let i = start + 1; i < args.length; i++) if (REQUIREMENT.test(args[i]!)) text.add(i);
}

function sqlArguments(name: string, args: readonly string[], text: Set<number>): void {
  const flags = Object.hasOwn(SQL_FLAGS, name) ? SQL_FLAGS[name]! : [];
  for (const [index, arg] of args.entries()) {
    if (flags.includes(arg) && index + 1 < args.length) text.add(index + 1);
  }
  if (name !== "sqlite3") return;
  let positional = 0;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (SQLITE_VALUE_OPTIONS.has(arg)) { i++; continue; }
    if (arg.startsWith("-")) continue;
    if (positional++ > 0) text.add(i);
  }
}

/**
 * block_patterns 검사에서 빼는 인자의 위치를 고른다.
 * 정책이 검색어나 출력 형식이라고 표시한 값(textFlags의 값 `-e 값`, `--format=값`)과
 * patternPositional 명령의 첫 위치 인자(grep의 검색어), 인터프리터의 인라인 코드(`python3 -c 코드`), 데이터베이스 클라이언트의 SQL을 뺀다.
 * 명령은 셸 없이 실행하므로 이 값 안의 `|`, `;`, `>`는 문자 그대로 전달된다.
 */
function textArguments(cmd: string, args: string[], policy: CommandPolicy | undefined): Set<number> {
  const text = new Set<number>();
  /** `/opt/venv/bin/python3`처럼 경로로 부른 인터프리터와 `python3.12` 같은 버전 이름도 같은 인터프리터로 본다 */
  const name = path.basename(cmd).replace(/^(python\d?)(\.\d+)?$/, "$1");
  const code = Object.hasOwn(INLINE_CODE_FLAGS, name) ? INLINE_CODE_FLAGS[name]! : [];
  /** 인라인 코드 플래그는 스크립트 이름보다 앞에만 온다. 위치 인자가 나오면 그 뒤는 스크립트의 인자다. */
  for (const [index, arg] of args.entries()) {
    if (code.includes(arg)) {
      if (index + 1 < args.length) text.add(index + 1);
      break;
    }
    if (!arg.startsWith("-")) break;
  }
  sqlArguments(name, args, text);
  requirementArguments(name, args, text);
  if (!policy) return text;
  const textFlags = policy.textFlags ?? [];
  for (const [index, arg] of args.entries()) {
    if (textFlags.includes(arg) && index + 1 < args.length) text.add(index + 1);
    if (textFlags.some(flag => arg.startsWith(`${flag}=`)))  text.add(index);
  }
  const explicitPattern = args.some(arg => /^(-[ef]|--regexp|--file)(=|$)/.test(arg));
  if (policy.patternPositional && !explicitPattern) {
    const first = tokenizeArgs(args, policy.flags, policy.singleDashLong, { numericFlag: policy.numericFlag })
      .find(token => token.kind === "positional");
    if (first) text.add(args.indexOf(first.name));
  }
  return text;
}

/**
 * 경로로 지정한 실행 파일을 허용할지 판단한다.
 * guard.workspace_executables가 켜져 있고 build 프로필이며, cmd가 경로이고(`/` 포함),
 * 심볼릭 링크를 따라간 실제 파일이 allowed_paths 안에 있을 때만 허용한다.
 * build 프로필은 이미 저장소의 빌드 스크립트를 실행하므로, 같은 범위의 실행 파일을 실행 대상으로 받는다.
 */
function isWorkspaceExecutable(cmd: string, cwd: string, guard: PrismConfig["guard"]): boolean {
  if (guard.workspace_executables !== true || !isBuildProfile(guard)) return false;
  if (!cmd.includes("/") || /\s/.test(cmd) || guard.allowed_paths.length === 0) return false;
  try {
    const real = realpathSync(path.resolve(cwd, cmd));
    return statSync(real).isFile() && isAllowedPath(real, guard.allowed_paths);
  } catch {
    return false;
  }
}

/**
 * 출력 파일 플래그가 /dev/null을 가리키면 아무 파일도 쓰지 않는다(`curl -o /dev/null -w '%{http_code}'`).
 * 출력 파일을 막는 인자 제한에서 이 경우만 뺀다.
 */
function discardsOutput(flag: string, arg: string, next: string | undefined): boolean {
  if (flag !== "-o" && flag !== "--output") return false;
  return arg === "--output=/dev/null" || ((arg === "-o" || arg === "--output") && next === "/dev/null");
}

export function checkGuard(
  cmd:    string,
  args:   string[],
  cwd:    string,
  config: PrismConfig,
): void {
  const { guard } = config;

  if (!guard.allowed_commands.includes(cmd) && !isWorkspaceExecutable(cmd, cwd, guard)) {
    throw new GuardError(
      `Command '${cmd}' is not in the allowed list${commandLineHint(cmd, guard.allowed_commands)}`,
      "command_not_allowed",
    );
  }

  const text = textArguments(cmd, args, resolvePolicies(guard)[cmd]);
  for (const pattern of guard.block_patterns) {
    for (const [index, arg] of args.entries()) {
      if (text.has(index)) continue;
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
    for (const [index, arg] of args.entries()) {
      // --flag=value 형태에서 플래그 이름만 추출
      const normalized = arg.startsWith("--") ? arg.split("=")[0]! : arg;
      if (discardsOutput(normalized, arg, args[index + 1])) continue;
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
  const source   = policySource(guard, cmd) ?? "default";
  const operands = !policy
    ? { tokens: tokenizePolicyless(args), view: undefined }
    : isVersionQuery(cmd, args, source)
      ? { tokens: [], view: undefined }
      : checkPolicy(cmd, args, policy, source);

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
      /** /dev/null은 읽으면 비어 있고 쓰면 버려지는 장치라 허용 경로 밖이어도 아무것도 드러내거나 바꾸지 않는다 */
      if (resolvedArgPath === "/dev/null") continue;
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

/**
 * 기본 명령의 버전 조회인지 판단한다. 인자가 정확히 `--version` 하나이고
 * 유효 정책이 command_policies가 아닌 기본 정책이나 build 프로필 정책이어야 한다.
 */
function isVersionQuery(cmd: string, args: string[], source: PolicySource): boolean {
  return args.length === 1 && args[0] === "--version" && source !== "config" && hasPolicy(DEFAULT_POLICIES, cmd);
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
 * 위치 인자는 정책의 positionalChars, positionalPrefix, maxPositionals 조건도 만족해야 한다.
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
    plusFlags:        policy.plusFlags,
  });
  const verbs           = sub !== undefined ? policy.subVerbs?.[sub] : undefined;
  let   verbChecked     = verbs === undefined;
  const optionalVerb    = sub !== undefined && policy.optionalVerbs?.includes(sub) === true;
  const prefixes        = sub !== undefined ? policy.subPositionalPrefixes?.[sub] : undefined;
  const deniedVerbs     = sub !== undefined ? policy.subDeniedVerbs?.[sub] : undefined;
  let   positionalCount = 0;

  for (const t of tokens) {
    if (t.passthrough) {
      operands.push(t);
      continue;
    }
    if (t.kind === "flag") {
      const kind = flagKind(flags, t.name);
      /** --help와 --version은 GNU echo도 플래그로 읽어 도움말을 낸다. 글자로 보지 않는다. */
      if (!kind && policy.unknownFlagsAreText && t.name !== "--help" && t.name !== "--version") continue;
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
    if (prefixes && positionalCount === 0 && !prefixes.some(p => t.name === p || (p.endsWith(".") ? t.name.startsWith(p) : t.name === p))) {
      deny(cmd, t.name, source);
    }
    if (deniedVerbs && positionalCount === 0 && deniedVerbs.includes(t.name)) deny(cmd, t.name, source);
    if (positionalMode === "none") deny(cmd, t.name, source);
    if (positionalMode === "url" && !/^https?:\/\//i.test(t.name)) deny(cmd, t.name, source);
    if (!isAllowedPositional(policy, t.name, ++positionalCount)) deny(cmd, t.name, source);
    operands.push(t);
  }
  if (!verbChecked && !optionalVerb) deny(cmd, "(missing verb)", source);
  return { tokens: operands, view: { ...policy, flags, positionals: positionalMode } };
}

/**
 * 위치 인자가 정책의 문자 집합, 접두사, 개수 조건을 만족하는지 검사한다. 조건이 없으면 허용한다.
 * position은 1부터 센 위치 인자 순번이다.
 */
function isAllowedPositional(policy: CommandPolicy, arg: string, position: number): boolean {
  if (policy.maxPositionals !== undefined && position > policy.maxPositionals) return false;
  if (policy.positionalPrefix !== undefined && !arg.startsWith(policy.positionalPrefix)) return false;
  if (policy.positionalChars !== undefined) {
    const chars = policy.positionalChars;
    if (arg.length === 0 || [...arg].some(ch => !chars.includes(ch))) return false;
  }
  return true;
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
 * - `key=값`, `+opt=값` 형태의 위치 인자는 첫 `=` 뒤 값이 `/`를 포함하거나 `.`, `~`로 시작하면 그 값도 모은다.
 *   위치 인자 규칙이 url인 명령은 URL 질의 문자열 때문에, textPositionals 명령은 위치 인자가 검색어나 출력 문자열이라 제외한다.
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
    const eq = t.name.indexOf("=");
    if (eq < 0 || policy?.positionals === "url" || policy?.textPositionals === true) continue;
    if (isPathLikeValue(t.name.slice(eq + 1))) out.push(t.name.slice(eq + 1));
  }
  if (passthrough.length > 0) out.push(...collectPathCandidates(tokenizePolicyless(passthrough), undefined, cwd));
  return out;
}
