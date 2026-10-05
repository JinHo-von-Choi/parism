/**
 * 명령별 능력 조회(describe의 cmd 인자).
 * 한 명령의 유효 guard 정책, 파서 계약의 형식 선언, 형식 밖 인자의 대체 안내, 예시를 한 응답으로 모은다.
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 */

import type { PrismConfig }                       from "../config/loader.js";
import type { ParserContract, ParserRegistry }    from "../parsers/registry.js";
import { hasFormatDeclaration, NUMBER_FLAG }      from "../parsers/format.js";
import type { FailureInfo }                       from "../types/envelope.js";
import type { CommandOutcomeCounts }              from "../engine/telemetry.js";
import { checkGuard, GuardError }                 from "../engine/guard.js";
import { effectiveFlags, policySource, resolvePolicies, type CommandPolicy } from "../engine/policy.js";

/**
 * 명령별 예시 인자. 응답에는 현재 설정의 guard를 통과하는 것만 싣는다(build 프로필 전용 예시는 readonly에서 빠진다).
 */
export const COMMAND_EXAMPLES: Readonly<Record<string, readonly string[][]>> = {
  ls:         [["-l"], ["-la", "src"]],
  find:       [[".", "-name", "*.ts", "-type", "f"], [".", "-maxdepth", "1"]],
  stat:       [["package.json"]],
  du:         [["-sh", "."]],
  df:         [["-h"], ["-T"]],
  tree:       [["-L", "2", "."]],
  ps:         [["aux"]],
  ping:       [["-c", "3", "example.com"]],
  curl:       [["-sI", "https://example.com"]],
  netstat:    [["-tlnp"]],
  lsof:       [["-nP", "-iTCP", "-sTCP:LISTEN"]],
  ss:         [["-tlnp"]],
  dig:        [["example.com", "A"]],
  grep:       [["-rn", "TODO", "src"]],
  wc:         [["-l", "package.json"]],
  head:       [["-n", "20", "README.md"]],
  tail:       [["-n", "20", "README.md"]],
  cat:        [["package.json"]],
  git:        [["status"], ["log", "--oneline", "-n", "10"]],
  env:        [[]],
  pwd:        [[]],
  which:      [["node"]],
  echo:       [["hello"]],
  date:       [["+%Y-%m-%d"]],
  uname:      [["-a"]],
  hostname:   [[]],
  free:       [["-b"]],
  id:         [[]],
  kubectl:    [["get", "pods", "-o", "json"]],
  docker:     [["ps", "-a"]],
  gh:         [["pr", "list", "--json", "number,title"]],
  systemctl:  [["list-units", "--type", "service", "--no-pager"]],
  journalctl: [["-u", "ssh", "-n", "50", "-o", "short-iso", "--no-pager"]],
  helm:       [["list", "-A"]],
  terraform:  [["version", "-json"]],
  apt:        [["list", "--installed"]],
  brew:       [["list", "--versions"]],
  npm:        [["ls", "--depth", "0"], ["test"], ["run", "build"]],
  pnpm:       [["list", "--depth", "0"]],
  cargo:      [["--version"], ["tree", "--depth", "1"], ["test"]],
};

/**
 * 파서 형식 밖의 대표 인자. 응답의 alternatives는 이 인자에 대한 형식 안내(parsers/hints.ts)를 계산한 것이다.
 */
export const ALTERNATIVE_SAMPLES: Readonly<Record<string, readonly string[][]>> = {
  ls:         [[]],
  df:         [["-B", "1G"]],
  ps:         [["-e"]],
  dig:        [["+short", "example.com"]],
  free:       [["--tebi"]],
  uname:      [[]],
  id:         [["-un"]],
  journalctl: [["-o", "verbose"]],
  systemctl:  [["status", "ssh"]],
  /**
   * `git status --porcelain` 은 이제 기본 지원 형식이라 '대안 형식'(안내가 필요한 형식) 목록에 없다.
   * 안내가 필요한 것은 long 형식을 사람이 읽을 때뿐이다.
   */
  git:        [["diff", "--stat"]],
  kubectl:    [["get", "deployments"]],
  docker:     [["ps", "--format", "{{.Names}}"]],
  gh:         [["issue", "list"]],
  npm:        [["outdated"]],
};

/**
 * 유효 정책 요약. origin은 정책이 온 계층이며 정책 없이 허용된 명령은 none이다.
 * 이름 목록 필드(subcommands, flags, leading_flags, sub_verbs와 sub_flags의 값, file_ref_flags, blocked_flags)는 공백으로 이은 문자열이다.
 */
export interface PolicyDescription {
  origin:             "default" | "build" | "config" | "none";
  subcommands?:       string;
  flags?:             string;
  positionals?:       CommandPolicy["positionals"];
  sub_positionals?:   Record<string, string>;
  sub_verbs?:         Record<string, string>;
  sub_flags?:         Record<string, string>;
  leading_flags?:     string;
  allowed_values?:    Record<string, string[]>;
  max_positionals?:   number;
  positional_chars?:  string;
  positional_prefix?: string;
  /** 값이 @로 시작하면 안 되는 플래그(로컬 파일 참조) */
  file_ref_flags?:    string;
  /** guard.command_arg_restrictions의 차단 플래그 */
  blocked_flags?:     string;
}

/** 파서 계약의 형식 선언 요약. 이름 목록 필드(flags, leading_flags, requires, exclusive, row_fields)는 공백으로 이은 문자열이다. */
export interface ParserDescription {
  /** 형식 선언이 없어 인자와 관계없이 파싱을 시도한다. */
  any_args?:        true;
  leading_flags?:   string;
  /** 출력 형식을 확인한 그 밖의 플래그. requires, values, flags 밖의 플래그는 unsupported_format이다. */
  flags?:           string;
  /** 허용 값이 정해진 플래그와 그 값 패턴(전체 일치) */
  values?:          Record<string, string>;
  /** 출력 형식을 정하는 플래그. 이 가운데 하나 이상이 있어야 한다. */
  requires?:        string;
  /** 이 가운데 하나까지만 쓸 수 있다. */
  exclusive?:       string;
  positionals?:     { min?: number; max?: number; pattern?: string };
  rows_key?:        string;
  row_fields?:      string;
  /** 서브커맨드별 형식. 빈 문자열 키는 서브커맨드 없는 실행이다. */
  subcommands?:     Record<string, ParserDescription>;
}

/** 형식 밖 인자(from)를 대신할 인자(args) */
export interface AlternativeDescription {
  from:   string[];
  args:   string[];
  reason: string;
}

export interface CommandDescription {
  cmd:          string;
  profile:      "readonly" | "build";
  policy:       PolicyDescription;
  parser:       ParserDescription | null;
  alternatives: AlternativeDescription[];
  examples:     string[][];
  /** 텔레메트리를 켰을 때만 있는 이 명령의 결과 횟수 */
  stats?:       CommandOutcomeCounts;
}

export interface CommandDescriptionFailure {
  cmd:     string;
  failure: FailureInfo;
}

function keysOf(table: Readonly<Record<string, unknown>>): string[] {
  return Object.keys(table);
}

/** 이름 목록(서브커맨드, 플래그, 필드)은 응답 크기를 줄이려고 공백으로 이은 문자열로 싣는다. */
function nameList(names: readonly string[]): string {
  return names.join(" ");
}

function mapValues<T, U>(table: Readonly<Record<string, T>>, fn: (value: T) => U): Record<string, U> {
  return Object.fromEntries(Object.entries(table).map(([k, v]) => [k, fn(v)]));
}

/** 명령의 유효 정책. 정책 없이 허용된 명령이면 undefined */
function policy(config: PrismConfig, cmd: string): CommandPolicy | undefined {
  return policySource(config.guard, cmd) === undefined ? undefined : resolvePolicies(config.guard)[cmd];
}

function describePolicy(config: PrismConfig, cmd: string): PolicyDescription {
  const guard   = config.guard;
  const origin  = policySource(guard, cmd) ?? "none";
  const blocked = Object.hasOwn(guard.command_arg_restrictions, cmd) ? guard.command_arg_restrictions[cmd]!.blocked_flags : undefined;
  const out: PolicyDescription = { origin };
  if (origin !== "none") {
    const p = resolvePolicies(guard)[cmd]!;
    if (p.subcommands)      out.subcommands       = nameList(p.subcommands);
    out.flags       = nameList(keysOf(p.flags));
    out.positionals = p.positionals;
    if (p.subPositionals)   out.sub_positionals   = { ...p.subPositionals };
    if (p.subVerbs)         out.sub_verbs         = mapValues(p.subVerbs, nameList);
    if (p.subFlags) {
      /** 이름만 싣으므로 기본 플래그 표에 없는 이름만 서브커맨드별로 남긴다. */
      const extra = Object.entries(p.subFlags).map(([sub, t]) => [sub, keysOf(t).filter(n => !Object.hasOwn(p.flags, n))] as const).filter(([, n]) => n.length > 0);
      if (extra.length > 0) out.sub_flags = Object.fromEntries(extra.map(([sub, n]) => [sub, nameList(n)]));
    }
    if (p.leadingFlags)     out.leading_flags     = nameList(p.leadingFlags);
    if (p.allowedValues)    out.allowed_values    = mapValues(p.allowedValues, v => [...v]);
    if (p.maxPositionals !== undefined) out.max_positionals = p.maxPositionals;
    if (p.positionalChars)  out.positional_chars  = p.positionalChars;
    if (p.positionalPrefix) out.positional_prefix = p.positionalPrefix;
    if (p.fileRefFlags)     out.file_ref_flags    = nameList(p.fileRefFlags);
  }
  if (blocked && blocked.length > 0) out.blocked_flags = nameList(blocked);
  return out;
}

/**
 * 플래그 이름이 guard를 통과하는지 판정하는 함수. 정책이 없으면 모든 이름을 통과로 본다.
 * 서브커맨드 이름을 받으면 그 서브커맨드의 플래그 표(subFlags)도 본다. 숫자 축약(-<number>)은 numericFlag를 따른다.
 */
type FlagFilter = (name: string, sub?: string) => boolean;

function policyFlagFilter(policy: CommandPolicy | undefined): FlagFilter {
  if (!policy) return () => true;
  return (name, sub) => name === NUMBER_FLAG
    ? policy.numericFlag === true
    : Object.hasOwn(effectiveFlags(policy, sub), name);
}

/**
 * 계약 선언을 요약한다. 출력 모양 가운데 행 배열 키와 필드만 싣는다.
 * 플래그 목록은 파서가 처리하고 guard도 허용하는 이름만 남긴다(guard가 막는 플래그는 쓸 수 없으므로).
 * 앞쪽 전역 옵션은 정책이 없을 때만 싣는다. 정책이 있으면 guard가 허용하는 것은 policy.leading_flags에 이미 있다.
 */
function describeContract(contract: ParserContract, allowed: FlagFilter, withLeading: boolean, sub?: string): ParserDescription {
  const keep = (names: readonly string[]): string => nameList(names.filter(n => allowed(n, sub)));
  const out: ParserDescription = {};
  if (contract.leadingFlags && withLeading) out.leading_flags = keep(keysOf(contract.leadingFlags));
  const values = Object.entries(contract.acceptedValues ?? {}).filter(([flag]) => allowed(flag, sub));
  const listed = new Set([...keysOf(contract.acceptedValues ?? {}), ...(contract.requiredFlags ?? [])]);
  if (contract.acceptedFlags)  out.flags     = keep(keysOf(contract.acceptedFlags).filter(n => !listed.has(n)));
  if (values.length > 0)       out.values    = Object.fromEntries(values.map(([flag, re]) => [flag, re.source]));
  if (contract.requiredFlags)  out.requires  = keep(contract.requiredFlags);
  if (contract.exclusiveFlags) out.exclusive = keep(contract.exclusiveFlags);
  if (contract.acceptedPositionals) {
    const { min, max, pattern } = contract.acceptedPositionals;
    out.positionals = { ...(min !== undefined && { min }), ...(max !== undefined && { max }), ...(pattern && { pattern: pattern.source }) };
  }
  if (contract.rowsKey)        out.rows_key   = contract.rowsKey;
  if (contract.rowFields)      out.row_fields = nameList(contract.rowFields);
  if (contract.subcommands)    out.subcommands = Object.fromEntries(Object.entries(contract.subcommands)
    .map(([key, c]) => [key, describeContract(c, allowed, withLeading, key.split(" ")[0])]));
  for (const key of ["leading_flags", "exclusive"] as const) if (out[key] === "") delete out[key];
  return out;
}

function describeParser(registry: ParserRegistry, cmd: string, policy: CommandPolicy | undefined): ParserDescription | null {
  if (!registry.hasParser(cmd)) return null;
  const contract = registry.declaredContract(cmd);
  const allowed  = policyFlagFilter(policy);
  if (!contract || !hasFormatDeclaration(contract)) return { any_args: true, ...(contract && describeContract(contract, allowed, !policy)) };
  return describeContract(contract, allowed, !policy);
}

function describeAlternatives(registry: ParserRegistry, cmd: string): AlternativeDescription[] {
  const samples = Object.hasOwn(ALTERNATIVE_SAMPLES, cmd) ? ALTERNATIVE_SAMPLES[cmd]! : [];
  const out: AlternativeDescription[] = [];
  for (const from of samples) {
    const hint = registry.formatHint(cmd, [...from]);
    if (hint) out.push({ from: [...from], args: hint.args, reason: hint.reason });
  }
  return out;
}

/** 예시 가운데 현재 설정의 guard를 통과하는 것. 경로 인자는 첫 허용 경로를 기준으로 판정한다. */
function describeExamples(config: PrismConfig, cmd: string): string[][] {
  const examples = Object.hasOwn(COMMAND_EXAMPLES, cmd) ? COMMAND_EXAMPLES[cmd]! : [];
  const cwd      = config.guard.allowed_paths[0] ?? process.cwd();
  return examples.filter(args => {
    try {
      checkGuard(cmd, [...args], cwd, config);
      return true;
    } catch (err) {
      if (err instanceof GuardError) return false;
      throw err;
    }
  }).map(args => [...args]);
}

/**
 * 한 명령의 능력 요약을 만든다. guard.allowed_commands에 없는 명령은 예외 대신 failure를 돌려준다.
 */
export function describeCommand(
  config:   PrismConfig,
  registry: ParserRegistry,
  cmd:      string,
): CommandDescription | CommandDescriptionFailure {
  if (!config.guard.allowed_commands.includes(cmd)) {
    return {
      cmd,
      failure: {
        kind:    "guard",
        reason:  "command_not_allowed",
        message: `Command '${cmd}' is not in guard.allowed_commands; call describe without cmd to list the allowed commands`,
      },
    };
  }
  return {
    cmd,
    profile:      config.guard.profile ?? "readonly",
    policy:       describePolicy(config, cmd),
    parser:       describeParser(registry, cmd, policy(config, cmd)),
    alternatives: describeAlternatives(registry, cmd),
    examples:     describeExamples(config, cmd),
  };
}
