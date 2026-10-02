/**
 * 명령별 허용 정책(allowlist).
 * 정책이 정의된 명령은 서브커맨드·플래그·위치 인자를 허용목록으로만 통과시킨다.
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 */

import type { PrismGuardConfig } from "../config/loader.js";

export type FlagKind = "bool" | "value" | "path";

export interface CommandPolicy {
  subcommands?: string[];
  flags:        Record<string, FlagKind>;
  positionals:  "path" | "any" | "none" | "url";
  /** find, terraform처럼 단일 대시 긴 옵션(-name)을 쓰는 명령 */
  singleDashLong?: boolean;
  /** 서브커맨드별 위치 인자 허용 규칙. 미지정 시 positionals를 따른다. */
  subPositionals?: Record<string, "path" | "any" | "none">;
  /** 서브커맨드 앞에 올 수 있는 전역 bool 플래그 */
  leadingFlags?: string[];
  /** -5 같은 숫자 축약 플래그 허용 (git log -5) */
  numericFlag?: boolean;
  /** 서브커맨드별 하위 동사 허용목록. 지정된 서브커맨드는 첫 위치 인자가 목록에 있어야 한다. */
  subVerbs?: Record<string, string[]>;
  /** 값이 @로 시작하면 로컬 파일을 읽는 값 플래그. @ 값은 허용하지 않는다. */
  fileRefFlags?: string[];
  /** 첫 위치 인자(스크립트 경로, 실행 대상 이름) 이후 인자는 대상 프로그램 몫으로 보고 검사하지 않는다. */
  stopAtPositional?: boolean;
}

export type PolicySource = "default" | "build" | "config";

export interface ParsedArg {
  kind:         "flag" | "positional";
  name:         string;
  value?:       string;
  /** stopAtPositional 이후 분류 없이 넘긴 인자 */
  passthrough?: boolean;
}

export interface TokenizeOptions {
  /** 플래그 자리의 -5 같은 숫자 축약을 하나의 플래그 토큰으로 본다. */
  numericFlag?:      boolean;
  /** 첫 위치 인자 이후 인자는 passthrough 위치 인자로 넘긴다. */
  stopAtPositional?: boolean;
}

/**
 * 인자 배열을 플래그/위치 인자로 분해한다.
 * --long=value, 짧은 플래그 묶음(-abc), 값이 붙은 짧은 플래그(-nVALUE)를 정규화한다.
 * 값 소비 여부는 정책의 FlagKind로 판단한다. 값 플래그가 소비한 인자는 숫자 축약으로 보지 않는다.
 */
export function tokenizeArgs(
  args:           string[],
  flags:          Record<string, FlagKind>,
  singleDashLong: boolean         = false,
  opts:           TokenizeOptions = {},
): ParsedArg[] {
  const out: ParsedArg[] = [];
  let   endOfFlags       = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;

    if (endOfFlags || arg === "-" || !arg.startsWith("-")) {
      out.push({ kind: "positional", name: arg });
      if (opts.stopAtPositional) {
        for (const rest of args.slice(i + 1)) out.push({ kind: "positional", name: rest, passthrough: true });
        break;
      }
      continue;
    }
    if (arg === "--") { endOfFlags = true; continue; }
    if (opts.numericFlag && /^-[0-9]+$/.test(arg)) {
      out.push({ kind: "flag", name: arg });
      continue;
    }

    if (arg.startsWith("--") || (singleDashLong && arg.length > 2)) {
      const eq   = arg.indexOf("=");
      const name = eq >= 0 ? arg.slice(0, eq) : arg;
      if (eq >= 0) {
        out.push({ kind: "flag", name, value: arg.slice(eq + 1) });
      } else if (flags[name] && flags[name] !== "bool" && i + 1 < args.length) {
        out.push({ kind: "flag", name, value: args[++i] });
      } else {
        out.push({ kind: "flag", name });
      }
      continue;
    }

    for (let j = 1; j < arg.length; j++) {
      const name = "-" + arg[j];
      const kind = flags[name];
      if (kind && kind !== "bool") {
        const rest = arg.slice(j + 1);
        if (rest.length > 0)          out.push({ kind: "flag", name, value: rest });
        else if (i + 1 < args.length) out.push({ kind: "flag", name, value: args[++i] });
        else                          out.push({ kind: "flag", name });
        break;
      }
      out.push({ kind: "flag", name });
    }
  }
  return out;
}

/** gh 하위 동사 허용목록 */
export const GH_READ_VERBS = ["list", "view", "status", "checks", "diff"];

const COMMON_GIT_READ = ["status", "log", "diff", "show", "branch", "rev-parse", "ls-files", "blame", "describe", "shortlog", "tag", "remote"];

/**
 * 기본 정책. 읽기 전용 용도에 필요한 최소 범위만 허용한다.
 */
export const DEFAULT_POLICIES: Record<string, CommandPolicy> = {
  env: { flags: {}, positionals: "none" },
  git: {
    subcommands: COMMON_GIT_READ,
    flags: {
      "--no-pager": "bool", "--oneline": "bool", "-n": "value", "--max-count": "value",
      "--stat": "bool", "--name-only": "bool", "--name-status": "bool", "--cached": "bool",
      "--staged": "bool", "-s": "bool", "-b": "bool", "--short": "bool", "--porcelain": "bool",
      "-v": "bool", "-vv": "bool", "-a": "bool", "-r": "bool", "--all": "bool", "--graph": "bool",
      "--decorate": "bool", "--format": "value", "--pretty": "value", "--since": "value",
      "--until": "value", "--author": "value", "-p": "bool", "--patch": "bool", "-U": "value",
      "--unified": "value", "--abbrev-commit": "bool", "--no-color": "bool", "--show-current": "bool",
      "-L": "value", "--merged": "bool", "--no-merged": "bool", "-l": "bool", "--list": "bool",
      "--abbrev-ref": "bool", "--show-toplevel": "bool", "-w": "bool", "--numstat": "bool",
      "--shortstat": "bool", "--reverse": "bool", "--first-parent": "bool", "--no-merges": "bool", "--tags": "bool", "--always": "bool", "--long": "bool",
    },
    positionals: "any",
    subPositionals: { branch: "none", tag: "none", remote: "none" },
    leadingFlags: ["--no-pager"],
    numericFlag: true,
  },
  find: {
    flags: {
      "-name": "value", "-iname": "value", "-type": "value", "-maxdepth": "value", "-mindepth": "value",
      "-path": "value", "-ipath": "value", "-size": "value", "-mtime": "value", "-mmin": "value",
      "-newer": "path", "-empty": "bool", "-print": "bool", "-print0": "bool", "-not": "bool",
      "-o": "bool", "-a": "bool", "-and": "bool", "-or": "bool", "-prune": "bool", "-L": "bool",
      "-P": "bool", "-user": "value", "-perm": "value", "-regex": "value", "-iregex": "value",
    },
    positionals: "path",
    singleDashLong: true,
  },
  curl: {
    flags: {
      "-s": "bool", "-S": "bool", "--silent": "bool", "--show-error": "bool", "-I": "bool",
      "--head": "bool", "-i": "bool", "--include": "bool", "-L": "bool", "--location": "bool",
      "-v": "bool", "-H": "value", "--header": "value", "-m": "value", "--max-time": "value",
      "--connect-timeout": "value", "-w": "value", "--write-out": "value", "-f": "bool",
      "--fail": "bool", "-k": "bool", "--compressed": "bool", "-A": "value", "--user-agent": "value",
    },
    positionals:  "url",
    fileRefFlags: ["-H", "--header", "-w", "--write-out"],
  },
  node:   { flags: { "--version": "bool", "-v": "bool" }, positionals: "none" },
  npx:    { flags: { "--version": "bool" }, positionals: "none" },
  npm:    { subcommands: ["ls", "list", "outdated", "view", "info", "audit", "--version", "-v"], flags: { "--depth": "value", "--json": "bool", "--all": "bool", "--omit": "value", "--prod": "bool", "--long": "bool", "--global": "bool", "-g": "bool" }, positionals: "any" },
  pnpm:   { subcommands: ["list", "ls", "outdated", "why", "info", "--version"], flags: { "--depth": "value", "--json": "bool", "--long": "bool", "--prod": "bool", "-P": "bool", "--dev": "bool", "-D": "bool", "-r": "bool", "--recursive": "bool", "--global": "bool", "-g": "bool" }, positionals: "any" },
  yarn:   { subcommands: ["list", "ls", "outdated", "why", "info", "--version"], flags: { "--depth": "value", "--json": "bool", "--pattern": "value" }, positionals: "any" },
  docker: { subcommands: ["ps", "images", "inspect", "logs", "version", "info", "stats"], flags: { "-a": "bool", "--all": "bool", "-q": "bool", "--format": "value", "--no-trunc": "bool", "--tail": "value", "--since": "value", "--no-stream": "bool", "-f": "value", "--filter": "value" }, positionals: "any" },
  kubectl: { subcommands: ["get", "describe", "logs", "version", "top", "explain", "api-resources", "cluster-info"], flags: { "-n": "value", "--namespace": "value", "-A": "bool", "--all-namespaces": "bool", "-o": "value", "--output": "value", "-l": "value", "--selector": "value", "--tail": "value", "--since": "value", "-c": "value", "--container": "value", "--context": "value", "-w": "bool", "--show-labels": "bool", "--previous": "bool" }, positionals: "any" },
  helm:   { subcommands: ["list", "ls", "status", "history", "version"], flags: { "-n": "value", "--namespace": "value", "-A": "bool", "--all-namespaces": "bool", "-o": "value", "--output": "value", "-a": "bool", "--all": "bool" }, positionals: "any" },
  terraform: { subcommands: ["version"], flags: { "-json": "bool", "-no-color": "bool" }, positionals: "none", singleDashLong: true },
  cargo:  { subcommands: ["tree", "metadata", "--version", "-V", "search", "pkgid"], flags: { "--depth": "value", "--format-version": "value", "--no-deps": "bool", "-e": "value", "--edges": "value", "-i": "value", "--invert": "value" }, positionals: "any" },
  apt:    { subcommands: ["list", "show", "policy", "search"], flags: { "--installed": "bool", "--upgradable": "bool", "-a": "bool", "--all-versions": "bool" }, positionals: "any" },
  brew:   { subcommands: ["list", "info", "outdated", "--version", "search", "deps", "leaves", "config"], flags: { "--versions": "bool", "--formula": "bool", "--cask": "bool", "--json": "value", "-1": "bool", "--tree": "bool" }, positionals: "any" },
  systemctl: { subcommands: ["list-units", "list-unit-files", "status", "is-active", "is-enabled", "is-failed", "show", "list-timers", "--version"], flags: { "--no-pager": "bool", "--type": "value", "-t": "value", "--state": "value", "--all": "bool", "-a": "bool", "--failed": "bool", "-p": "value", "--property": "value", "--plain": "bool", "--no-legend": "bool", "-l": "bool", "--full": "bool", "--user": "bool" }, positionals: "any" },
  journalctl: { flags: { "-u": "value", "--unit": "value", "-n": "value", "--lines": "value", "--since": "value", "--until": "value", "-p": "value", "--priority": "value", "-o": "value", "--output": "value", "--no-pager": "bool", "-b": "bool", "--boot": "bool", "-k": "bool", "--dmesg": "bool", "-r": "bool", "--reverse": "bool", "-q": "bool", "--user": "bool", "-g": "value", "--grep": "value" }, positionals: "none" },
  gh:     { subcommands: ["pr", "issue", "repo", "run", "release", "status", "--version"], flags: { "--json": "value", "-L": "value", "--limit": "value", "-s": "value", "--state": "value", "-R": "value", "--repo": "value", "-q": "value", "--jq": "value", "--author": "value", "--label": "value", "-w": "bool", "--web": "bool" }, positionals: "any", subVerbs: { pr: GH_READ_VERBS, issue: GH_READ_VERBS, repo: GH_READ_VERBS, run: GH_READ_VERBS, release: GH_READ_VERBS } },
};

/**
 * 기본 정책의 서브커맨드 목록에 항목을 더한 정책을 만든다.
 */
function extendSubcommands(base: CommandPolicy, extra: string[], overrides: Partial<CommandPolicy> = {}): CommandPolicy {
  return { ...base, ...overrides, subcommands: [...(base.subcommands ?? []), ...extra] };
}

/**
 * guard.profile이 "build"일 때 기본 정책 위에 덮어쓰는 정책.
 * 빌드·시험 실행에 필요한 서브커맨드만 더한다. 경로 위치 인자는 allowed_paths 검사를 그대로 받는다.
 */
export const BUILD_PROFILE_POLICIES: Record<string, CommandPolicy> = {
  npm:       extendSubcommands(DEFAULT_POLICIES.npm!, ["run", "test", "ci"]),
  pnpm:      extendSubcommands(DEFAULT_POLICIES.pnpm!, ["run", "test"]),
  yarn:      extendSubcommands(DEFAULT_POLICIES.yarn!, ["run", "test"]),
  cargo:     extendSubcommands(DEFAULT_POLICIES.cargo!, ["build", "test", "check"], {
    subPositionals: { build: "none", check: "none" },
  }),
  terraform: extendSubcommands(DEFAULT_POLICIES.terraform!, ["show", "validate", "providers", "plan", "init"], {
    subPositionals: { show: "path" },
  }),
  node:      { flags: { "--version": "bool", "-v": "bool" }, positionals: "path", stopAtPositional: true },
  npx:       { flags: { "--version": "bool" }, positionals: "any", stopAtPositional: true },
  docker:    extendSubcommands(DEFAULT_POLICIES.docker!, ["compose"], {
    subVerbs: { compose: ["ps", "logs"] },
  }),
};

/**
 * 프로필과 설정을 반영한 명령별 유효 정책을 만든다.
 * 우선순위: guard.command_policies > build 프로필 > 기본 정책.
 */
export function resolvePolicies(guard: PrismGuardConfig): Record<string, CommandPolicy> {
  return {
    ...DEFAULT_POLICIES,
    ...(guard.profile === "build" ? BUILD_PROFILE_POLICIES : {}),
    ...(guard.command_policies ?? {}),
  };
}

/**
 * 명령의 유효 정책이 어느 계층에서 왔는지 반환한다. 정책이 없으면 undefined.
 */
export function policySource(guard: PrismGuardConfig, cmd: string): PolicySource | undefined {
  if (guard.command_policies?.[cmd])                            return "config";
  if (guard.profile === "build" && BUILD_PROFILE_POLICIES[cmd]) return "build";
  if (DEFAULT_POLICIES[cmd])                                    return "default";
  return undefined;
}

const GIT_CONFIG_OVERRIDES = ["-c", "core.fsmonitor=false", "-c", "core.pager=cat"];

/** 서브커맨드 뒤에 붙일 옵션. blame은 외부 diff 옵션을 받지 않으므로 textconv만 끈다. */
const GIT_SUBCOMMAND_OVERRIDES: Record<string, string[]> = {
  log:   ["--no-textconv", "--no-ext-diff"],
  show:  ["--no-textconv", "--no-ext-diff"],
  diff:  ["--no-textconv", "--no-ext-diff"],
  blame: ["--no-textconv"],
};

/**
 * 실제 실행에 쓸 인자 배열을 만든다. 입력 배열은 변경하지 않는다.
 * git이면 저장소 설정의 fsmonitor·pager를 끄는 -c 옵션을 맨 앞에 두고,
 * log·show·diff·blame 서브커맨드 뒤에는 textconv(및 외부 diff) 비활성 옵션을 붙인다.
 * 서브커맨드 위치는 유효 git 정책의 leadingFlags를 건너뛰어 찾는다. guard가 없으면 기본 정책을 쓴다.
 */
export function buildExecArgs(cmd: string, args: string[], guard?: PrismGuardConfig): string[] {
  if (cmd !== "git") return [...args];

  const policy  = guard ? resolvePolicies(guard).git : DEFAULT_POLICIES.git;
  const leading = policy?.leadingFlags ?? [];
  let   subIdx  = 0;
  while (subIdx < args.length && leading.includes(args[subIdx]!)) subIdx++;

  const extra = GIT_SUBCOMMAND_OVERRIDES[args[subIdx] ?? ""];
  if (!extra) return [...GIT_CONFIG_OVERRIDES, ...args];
  return [
    ...GIT_CONFIG_OVERRIDES,
    ...args.slice(0, subIdx + 1),
    ...extra,
    ...args.slice(subIdx + 1),
  ];
}
