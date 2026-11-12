/**
 * 명령별 허용 정책(allowlist).
 * 정책이 정의된 명령은 서브커맨드·플래그·위치 인자를 허용목록으로만 통과시킨다.
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 */

import type { PrismGuardConfig } from "../config/loader.js";

/**
 * 플래그 종류.
 * bool: 값을 받지 않는다. value: 붙은 값 또는 다음 인자를 값으로 받는다.
 * path: value와 같고 값이 경로 검사를 받는다.
 * attached: 값을 `--x=값` 또는 `-x값`처럼 붙여서만 받는다. 다음 인자를 값으로 소비하지 않는다.
 * count: 붙은 값을 받고, 다음 인자는 줄 수 형식(N, +N, all)일 때만 값으로 소비한다.
 */
export type FlagKind = "bool" | "value" | "path" | "attached" | "count";

/** count 플래그가 다음 인자를 값으로 소비하는 형식 */
const COUNT_VALUE = /^(\+?[0-9]+|all)$/;

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
  /** 플래그별 금지 부분 문자열. 값에 하나라도 포함되면 거부한다. */
  deniedValues?: Record<string, string[]>;
  /** 첫 위치 인자(스크립트 경로, 실행 대상 이름) 이후 인자는 대상 프로그램 몫으로 보고 검사하지 않는다. */
  stopAtPositional?: boolean;
  /** 서브커맨드별 플래그 종류. 같은 이름의 flags 항목보다 우선하며 그 서브커맨드에서만 쓰인다. */
  subFlags?: Record<string, Record<string, FlagKind>>;
  /** 플래그별 허용 값. "="로 끝나는 항목은 그 접두사로 시작하는 값을, 나머지 항목은 같은 값만 허용한다. */
  allowedValues?: Record<string, string[]>;
  /** 위치 인자 허용 문자. 지정하면 위치 인자는 이 문자로만 이루어져야 한다(ps의 옵션 낱말). */
  positionalChars?: string;
  /** 위치 인자 접두사. 지정하면 위치 인자는 이 문자열로 시작해야 한다(date의 +형식). */
  positionalPrefix?: string;
  /** 위치 인자 최대 개수 */
  maxPositionals?: number;
  /** `+`로 시작하는 인자도 `-` 플래그와 같이 플래그로 분해한다(lsof). */
  plusFlags?: boolean;
  /** 위치 인자가 검색어나 출력 문자열이다(grep, echo). `key=값` 위치 인자의 `=` 뒤 값을 따로 경로 검사하지 않는다. */
  textPositionals?: boolean;
  /** 값이 검색어나 출력 형식인 플래그(grep -e, git --format). 값에는 block_patterns 검사를 하지 않는다. */
  textFlags?: string[];
  /** 검색어를 -e나 -f로 주지 않았을 때 첫 위치 인자가 검색어다(grep). 그 인자에는 block_patterns 검사를 하지 않는다. */
  patternPositional?: boolean;
  /** 모르는 대시 낱말을 플래그가 아니라 글자로 본다(echo ---, echo -x는 그대로 출력된다). */
  unknownFlagsAreText?: boolean;
  /** subVerbs가 있는 서브커맨드 가운데 하위 동사 없이도 쓸 수 있는 것(git remote, git stash) */
  optionalVerbs?: string[];
  /** 서브커맨드별로 첫 위치 인자가 시작해야 하는 접두사 목록(git config의 설정 키) */
  subPositionalPrefixes?: Record<string, string[]>;
  /** 서브커맨드별로 첫 위치 인자로 올 수 없는 하위 동사(readonly의 git reflog delete, git stash drop) */
  subDeniedVerbs?: Record<string, string[]>;
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
  /** `+`로 시작하는 인자를 짧은 플래그 묶음처럼 분해한다. 플래그 이름은 `+` 접두사를 유지한다. */
  plusFlags?:        boolean;
}

/**
 * 인자 배열을 플래그/위치 인자로 분해한다.
 * --long=value, 짧은 플래그 묶음(-abc), 값이 붙은 짧은 플래그(-nVALUE)를 정규화한다.
 * 값 소비 여부는 정책의 FlagKind로 판단한다. 값 플래그가 소비한 인자는 숫자 축약으로 보지 않는다.
 * attached 플래그는 붙은 값만 받고 다음 인자를 소비하지 않는다.
 * plusFlags이면 `+`로 시작하는 인자(`+` 하나는 제외)도 같은 규칙으로 `+X` 이름의 플래그로 분해한다.
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

    const plus = opts.plusFlags === true && arg.length > 1 && arg.startsWith("+");
    if (endOfFlags || (!plus && (arg === "-" || !arg.startsWith("-")))) {
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

    if (!plus && (arg.startsWith("--") || (singleDashLong && arg.length > 2))) {
      const eq   = arg.indexOf("=");
      const name = eq >= 0 ? arg.slice(0, eq) : arg;
      if (eq >= 0) {
        out.push({ kind: "flag", name, value: arg.slice(eq + 1) });
      } else if (i + 1 < args.length && consumesNext(flags, name, args[i + 1]!)) {
        out.push({ kind: "flag", name, value: args[++i] });
      } else {
        out.push({ kind: "flag", name });
      }
      continue;
    }

    const prefix = arg[0]!;
    for (let j = 1; j < arg.length; j++) {
      const name = prefix + arg[j];
      const kind = flagKind(flags, name);
      if (kind && kind !== "bool") {
        const rest = arg.slice(j + 1);
        if (rest.length > 0)                                                  out.push({ kind: "flag", name, value: rest });
        else if (i + 1 < args.length && consumesNext(flags, name, args[i + 1]!)) out.push({ kind: "flag", name, value: args[++i] });
        else                                                                  out.push({ kind: "flag", name });
        break;
      }
      out.push({ kind: "flag", name });
    }
  }
  return out;
}

/**
 * 플래그 표가 없는 인자 배열을 분해한다. 어느 플래그가 값을 받는지 모르므로 가능한 해석을 모두 남긴다.
 * 대시로 시작하지 않는 인자는 위치 인자, --x=value는 값이 붙은 플래그다.
 * 짧은 플래그 묶음(-abVALUE)은 플래그 글자로 볼 수 있는 각 문자(영숫자)마다 그 뒤 나머지를 값으로 가진 플래그를 낸다.
 * `-`와 `--`는 버린다.
 */
export function tokenizePolicyless(args: string[]): ParsedArg[] {
  const out: ParsedArg[] = [];
  for (const arg of args) {
    if (arg === "-" || arg === "--") continue;
    if (!arg.startsWith("-")) {
      out.push({ kind: "positional", name: arg });
      continue;
    }
    if (arg.startsWith("--")) {
      const eq = arg.indexOf("=");
      out.push(eq >= 0 ? { kind: "flag", name: arg.slice(0, eq), value: arg.slice(eq + 1) } : { kind: "flag", name: arg });
      continue;
    }
    if (arg.length === 2) {
      out.push({ kind: "flag", name: arg });
      continue;
    }
    for (let j = 2; j < arg.length && /[A-Za-z0-9]/.test(arg[j - 1]!); j++) {
      out.push({ kind: "flag", name: "-" + arg[j - 1], value: arg.slice(j) });
    }
  }
  return out;
}

/** 플래그 종류 조회. 객체 프로토타입 키는 플래그로 보지 않는다. */
export function flagKind(flags: Record<string, FlagKind>, name: string): FlagKind | undefined {
  return Object.hasOwn(flags, name) ? flags[name] : undefined;
}

/** 붙은 값이 없을 때 플래그가 다음 인자를 값으로 소비하는지 판단한다. */
function consumesNext(flags: Record<string, FlagKind>, name: string, next: string): boolean {
  const kind = flagKind(flags, name);
  if (kind === "count") return COUNT_VALUE.test(next);
  return kind === "value" || kind === "path";
}

/** 서브커맨드에 적용할 플래그 표. subFlags 항목이 flags 항목을 덮어쓴다. */
export function effectiveFlags(policy: CommandPolicy, sub: string | undefined): Record<string, FlagKind> {
  if (sub === undefined || !policy.subFlags || !Object.hasOwn(policy.subFlags, sub)) return policy.flags;
  return { ...policy.flags, ...policy.subFlags[sub] };
}

/** gh 하위 동사 허용목록 */
export const GH_READ_VERBS = ["list", "view", "status", "checks", "diff"];

/** kubectl -o 허용 형식. 로컬 템플릿 파일을 읽는 *-file 형식은 넣지 않는다. */
const KUBECTL_OUTPUT_FORMATS = ["json", "yaml", "wide", "name", "jsonpath=", "jsonpath-as-json=", "custom-columns=", "go-template=", "template="];

const COMMON_GIT_READ = [
  "status", "log", "diff", "show", "branch", "rev-parse", "ls-files", "blame", "describe", "shortlog", "tag", "remote",
  "reflog", "worktree", "fsck", "cat-file", "rev-list", "ls-tree", "for-each-ref", "show-ref", "merge-base", "name-rev", "count-objects", "stash", "grep",
];

/** 조회 서브커맨드 가운데 저장소를 바꾸는 하위 동사. readonly 프로필에서 막는다. */
const GIT_READ_DENIED_VERBS: Record<string, string[]> = {
  reflog:   ["expire", "delete"],
};

/** 조회 서브커맨드 가운데 하위 동사를 골라야 읽기만 하는 것. `git stash` 하나만 쓰면 stash push다. */
const GIT_READ_VERBS: Record<string, string[]> = {
  stash:    ["list", "show"],
  worktree: ["list"],
};

/** 조회 서브커맨드의 플래그 */
const GIT_READ_SUB_FLAGS: Record<string, Record<string, FlagKind>> = {
  branch:   { "--format": "value", "--contains": "value", "--no-contains": "value", "--points-at": "value", "--sort": "value" },
  tag:      { "--format": "value", "-n": "attached" },
  blame:    { "-n": "bool" },
  shortlog: { "-n": "bool" },
  log:      { "-S": "value", "-G": "value", "--pickaxe-regex": "bool", "--pickaxe-all": "bool", "--grep": "value", "-i": "bool", "--regexp-ignore-case": "bool" },
  grep:     { ...bools("-n", "--line-number", "-i", "--ignore-case", "-l", "--files-with-matches", "-L", "-c", "--count", "-w", "--word-regexp", "-E", "--extended-regexp", "-F", "--fixed-strings", "-h", "-H", "--cached", "--untracked", "-I", "--full-name", "--break", "--heading"), "-e": "value", "-A": "value", "-B": "value", "-C": "value", "--max-depth": "value" },
  reflog:   { "--date": "value" },
  worktree: { "--porcelain": "bool" },
  fsck:     { "--unreachable": "bool", "--dangling": "bool", "--no-dangling": "bool", "--no-reflogs": "bool", "--full": "bool", "--connectivity-only": "bool", "--root": "bool", "--tags": "bool", "--cache": "bool", "--name-objects": "bool" },
  "cat-file": { "-t": "bool", "-s": "bool", "-e": "bool", "-p": "bool" },
  "rev-list": { "--count": "bool", "--objects": "bool", "--max-parents": "value", "--min-parents": "value", "--left-right": "bool", "--topo-order": "bool", "--date-order": "bool", "--parents": "bool", "--children": "bool", "--ancestry-path": "bool", "--branches": "bool", "--remotes": "bool" },
  "ls-tree": { "-r": "bool", "-d": "bool", "-t": "bool", "-l": "bool", "--long": "bool", "--name-only": "bool", "--name-status": "bool", "--full-tree": "bool", "--full-name": "bool", "--abbrev": "attached" },
  "for-each-ref": { "--format": "value", "--sort": "value", "--count": "value", "--contains": "value", "--no-contains": "value", "--points-at": "value", "--shell": "bool" },
  "show-ref": { "--heads": "bool", "--tags": "bool", "--hash": "bool", "--verify": "bool", "--head": "bool", "--abbrev": "attached", "-d": "bool", "--dereference": "bool" },
  "merge-base": { "--is-ancestor": "bool", "--octopus": "bool", "--fork-point": "bool", "--independent": "bool" },
  "name-rev": { "--name-only": "bool", "--no-undefined": "bool", "--always": "bool", "--refs": "value" },
  "count-objects": { "-v": "bool", "-H": "bool", "--human-readable": "bool" },
  stash:    { "--stat": "bool", "-p": "bool", "--patch": "bool", "--include-untracked": "bool", "-u": "bool", "--only-untracked": "bool" },
};

/** 이름 목록을 bool 플래그 표로 만든다. */
function bools(...names: string[]): Record<string, FlagKind> {
  return Object.fromEntries(names.map(n => [n, "bool" as const]));
}

/** head, tail 공통 플래그. tail의 추적(-f, -F, --follow)은 끝나지 않으므로 넣지 않는다. */
const HEAD_TAIL_FLAGS: Record<string, FlagKind> = {
  ...bools("-q", "--quiet", "--silent", "-v", "--verbose", "-z", "--zero-terminated"),
  "-n": "value", "--lines": "value", "-c": "value", "--bytes": "value",
};

/**
 * ps가 위치 인자로 받는 BSD식 옵션 낱말의 글자.
 * 목록 선택과 출력 형식 글자만 둔다. 환경 변수를 함께 출력하는 수식어(e), 값을 받는 글자, 목록과 무관한 글자는 넣지 않는다.
 * procps는 대시 옵션 해석이 실패하면 인자 전체를 BSD식으로 다시 읽어 대시 낱말의 e도 수식어로 쓴다.
 * 그래서 대시 옵션에는 UNIX식 해석이 없는 -x와, 없는 이름을 붙여 해석을 실패시킬 수 있는
 * 사용자·그룹 선택 옵션(-u, -U, -g, -G, --user)을 두지 않는다.
 */
const PS_OPTION_LETTERS = "auxfwrljsvhcmnSHTgZ";

/**
 * 파일·시스템 조회 명령 정책.
 * 출력 파일을 지정하는 옵션, 시스템 상태를 바꾸는 옵션과 위치 인자, 끝나지 않는 반복 실행 옵션,
 * 재귀 중 심볼릭 링크를 따라가는 옵션(ls -L, du -L, tree -l, grep -R)은 넣지 않는다.
 * date의 위치 인자는 +로 시작하는 출력 형식 하나만 받는다.
 */
const READ_COMMAND_POLICIES: Record<string, CommandPolicy> = {
  ls: {
    flags: {
      ...bools(
        "-a", "-A", "-l", "-h", "-R", "-t", "-S", "-r", "-1", "-d", "-F", "-i", "-n", "-s", "-g", "-o", "-p",
        "-c", "-u", "-U", "-X", "-v", "-x", "-C", "-m", "-Q", "-b", "-B", "-G", "-k", "-N", "-Z",
        "--all", "--almost-all", "--human-readable", "--si", "--recursive", "--reverse", "--directory", "--classify",
        "--inode", "--numeric-uid-gid", "--size", "--full-time", "--group-directories-first", "--no-group", "--author",
        "--escape", "--literal", "--quote-name", "--ignore-backups", "--kibibytes", "--context", "--file-type",
        "-f", "-q", "-D", "--zero",
      ),
      "--sort": "value", "--time": "value", "--time-style": "value", "--format": "value", "--color": "attached",
      "--indicator-style": "value", "--quoting-style": "value", "--block-size": "value",
      "-I": "value", "--ignore": "value", "--hide": "value", "-w": "value", "--width": "value",
      "-T": "value", "--hyperlink": "attached",
    },
    positionals: "path",
  },
  stat: {
    flags: {
      ...bools("-L", "--dereference", "-f", "--file-system", "-t", "--terse"),
      "-c": "value", "--format": "value", "--printf": "value",
    },
    positionals: "path",
  },
  du: {
    flags: {
      ...bools(
        "-s", "-h", "-a", "-c", "-k", "-m", "-b", "-x", "-H", "-D", "-P", "-0", "-l", "-S",
        "--summarize", "--human-readable", "--all", "--total", "--apparent-size", "--si", "--bytes",
        "--one-file-system", "--count-links", "--separate-dirs", "--null", "--no-dereference", "--dereference-args", "--inodes",
      ),
      "-d": "value", "--max-depth": "value", "--exclude": "value", "-t": "value", "--threshold": "value",
      "-B": "value", "--block-size": "value", "--time": "attached", "--time-style": "value",
    },
    positionals: "path",
  },
  df: {
    flags: {
      ...bools(
        "-h", "-H", "-k", "-m", "-g", "-a", "-i", "-l", "-P", "-T",
        "--total", "--si", "--human-readable", "--inodes", "--local", "--portability", "--print-type", "--all", "--no-sync",
      ),
      "-t": "value", "--type": "value", "-x": "value", "--exclude-type": "value",
      "-B": "value", "--block-size": "value", "--output": "attached",
    },
    positionals: "path",
  },
  tree: {
    flags: {
      ...bools(
        "-a", "-d", "-f", "-i", "-s", "-h", "-D", "-p", "-u", "-g", "-F", "-C", "-n", "-J", "-X", "-N", "-Q",
        "-r", "-t", "-c", "-U", "-v", "-x", "-A", "-S", "-q",
        "--dirsfirst", "--noreport", "--du", "--prune", "--si", "--inodes", "--device", "--gitignore", "--matchdirs", "--ignore-case",
        "--filesfirst",
      ),
      "-L": "value", "-I": "value", "-P": "value", "--charset": "value", "--filelimit": "value", "--sort": "attached", "--timefmt": "value",
      "-H": "value",
    },
    positionals: "path",
  },
  ps: {
    flags: {
      ...bools("-e", "-A", "-a", "-d", "-N", "-f", "-F", "-l", "-j", "-H", "-w", "-y", "-L", "-T", "-M", "-Z",
        "--forest", "--no-headers", "--headers", "--cumulative"),
      "-o": "value", "-O": "value", "--format": "value", "-p": "value", "--pid": "value", "--ppid": "value",
      "-C": "value", "-t": "value", "--sort": "value", "-q": "value", "--width": "value",
    },
    positionals:     "any",
    positionalChars: PS_OPTION_LETTERS,
  },
  ping: {
    flags: {
      ...bools("-q", "-n", "-4", "-6", "-D", "-O", "-v"),
      "-c": "value", "-i": "value", "-W": "value", "-w": "value", "-s": "value", "-t": "value", "-I": "value",
    },
    positionals: "any",
  },
  netstat: {
    flags: {
      ...bools(
        "-t", "-u", "-l", "-n", "-p", "-a", "-r", "-i", "-s", "-e", "-W", "-4", "-6", "-x", "-o", "-w", "-g", "-v",
        "--tcp", "--udp", "--listening", "--numeric", "--programs", "--all", "--route", "--interfaces", "--statistics",
        "--extend", "--wide", "--timers", "--raw", "--unix", "--groups", "--verbose",
      ),
      "-f": "value", "-A": "value", "--protocol": "value",
    },
    positionals: "none",
  },
  lsof: {
    flags: {
      ...bools("-n", "-P", "-t", "-a", "-l", "-R", "-U", "-w", "-V", "-b", "-N", "-X", "-h"),
      "-i": "attached", "-s": "attached", "-F": "attached", "-g": "attached",
      "-p": "value", "-u": "value", "-c": "value", "-d": "value",
    },
    positionals: "path",
    plusFlags:   true,
  },
  ss: {
    flags: {
      ...bools(
        "-t", "-u", "-l", "-n", "-p", "-a", "-x", "-w", "-4", "-6", "-s", "-e", "-m", "-i", "-o", "-H", "-r", "-0",
        "-S", "-d", "-M", "-Z", "-z", "-b", "-O",
        "--tcp", "--udp", "--listening", "--numeric", "--processes", "--all", "--unix", "--raw", "--ipv4", "--ipv6",
        "--summary", "--extended", "--memory", "--info", "--options", "--no-header", "--resolve", "--packet", "--dccp",
        "--sctp", "--mptcp", "--oneline", "--context", "--contexts", "--bpf",
      ),
      "-f": "value", "--family": "value", "-A": "value", "--query": "value",
    },
    positionals: "any",
  },
  dig: {
    flags: {
      ...bools("-4", "-6", "-m", "-u", "-r"),
      "-x": "value", "-t": "value", "-c": "value", "-p": "value", "-q": "value", "-b": "value",
    },
    positionals: "any",
  },
  grep: {
    flags: {
      ...bools(
        "-r", "-n", "-l", "-L", "-i", "-v", "-w", "-x", "-c", "-o", "-h", "-H", "-E", "-F", "-G", "-P", "-s", "-q", "-a",
        "-I", "-z", "-Z", "-U", "-b", "-T", "-y",
        "--recursive", "--line-number", "--files-with-matches", "--files-without-match", "--ignore-case", "--no-ignore-case",
        "--invert-match", "--word-regexp", "--line-regexp", "--count", "--only-matching", "--no-filename", "--with-filename",
        "--extended-regexp", "--fixed-strings", "--basic-regexp", "--perl-regexp", "--no-messages", "--quiet", "--silent",
        "--text", "--null", "--null-data", "--binary", "--byte-offset", "--initial-tab", "--line-buffered",
      ),
      "-e": "value", "--regexp": "value", "-f": "path", "--file": "path", "-m": "value", "--max-count": "value",
      "-A": "value", "--after-context": "value", "-B": "value", "--before-context": "value", "-C": "value", "--context": "value",
      "--include": "value", "--exclude": "value", "--exclude-dir": "value", "--exclude-from": "path", "--color": "attached", "--colour": "attached",
      "--binary-files": "value", "--label": "value", "-d": "value", "--directories": "value", "-D": "value", "--devices": "value",
    },
    positionals:     "any",
    numericFlag:     true,
    textPositionals: true,
    textFlags:       ["-e", "--regexp"],
    patternPositional: true,
  },
  wc: {
    flags: {
      ...bools("-l", "-w", "-c", "-m", "-L", "--lines", "--words", "--bytes", "--chars", "--max-line-length"),
      "--total": "attached",
    },
    positionals: "path",
  },
  head: { flags: HEAD_TAIL_FLAGS, positionals: "path", numericFlag: true },
  tail: { flags: HEAD_TAIL_FLAGS, positionals: "path", numericFlag: true },
  cat: {
    flags: bools(
      "-n", "-b", "-A", "-E", "-T", "-v", "-s", "-e", "-t", "-u",
      "--number", "--number-nonblank", "--show-all", "--show-ends", "--show-tabs", "--squeeze-blank", "--show-nonprinting",
    ),
    positionals: "path",
  },
  pwd:   { flags: bools("-L", "-P"), positionals: "none" },
  which: { flags: bools("-a", "--all", "-s"), positionals: "any" },
  echo:  { flags: bools("-n", "-e", "-E"), positionals: "any", textPositionals: true, unknownFlagsAreText: true },
  date: {
    flags: {
      ...bools("-u", "--utc", "--universal", "-R", "--rfc-email", "--debug"),
      "-I": "attached", "--iso-8601": "attached", "--rfc-3339": "attached",
      "-d": "value", "--date": "value", "-r": "path", "--reference": "path",
    },
    positionals:      "any",
    positionalPrefix: "+",
    maxPositionals:   1,
  },
  uname: {
    flags: bools(
      "-a", "-s", "-n", "-r", "-v", "-m", "-p", "-i", "-o",
      "--all", "--kernel-name", "--nodename", "--kernel-release", "--kernel-version", "--machine", "--processor",
      "--hardware-platform", "--operating-system",
    ),
    positionals: "none",
  },
  hostname: {
    flags: bools(
      "-s", "-f", "-d", "-i", "-I", "-A", "-a",
      "--short", "--fqdn", "--long", "--domain", "--ip-address", "--all-ip-addresses", "--all-fqdns", "--alias",
    ),
    positionals: "none",
  },
  free: {
    flags: bools(
      "-b", "-k", "-m", "-g", "-h", "-w", "-t", "-l", "-v",
      "--bytes", "--kilo", "--mega", "--giga", "--tera", "--peta", "--kibi", "--mebi", "--gibi", "--tebi", "--pebi",
      "--human", "--si", "--total", "--wide", "--lohi", "--committed", "--line",
    ),
    positionals: "none",
  },
  id: {
    flags: bools(
      "-u", "-g", "-G", "-n", "-r", "-a", "-z", "-Z",
      "--user", "--group", "--groups", "--name", "--real", "--zero", "--context",
    ),
    positionals: "any",
  },
};

/**
 * 기본 정책. 읽기 전용 용도에 필요한 최소 범위만 허용한다.
 */
export const DEFAULT_POLICIES: Record<string, CommandPolicy> = {
  ...READ_COMMAND_POLICIES,
  env: { flags: {}, positionals: "none" },
  git: {
    subcommands: COMMON_GIT_READ,
    flags: {
      "--no-pager": "bool", "--oneline": "bool", "-n": "value", "--max-count": "value",
      "--stat": "bool", "--name-only": "bool", "--name-status": "bool", "--cached": "bool",
      "--staged": "bool", "-s": "bool", "-b": "bool", "--short": "bool",
      /**
       * porcelain 은 버전이 붙는 형식(`--porcelain=v1`)이라 attached 로 받는다.
       * `-z`/`--null` 은 NUL 로 레코드를 나눠 경로를 가공 없이 내는 형식이다(계획서 5장 근거 조회).
       */
      "--porcelain": "attached", "-z": "bool", "--null": "bool", "--branch": "bool",
      "-v": "bool", "-vv": "bool", "-a": "bool", "-r": "bool", "--all": "bool", "--graph": "bool",
      "--decorate": "bool", "--format": "attached", "--pretty": "attached", "--since": "value",
      "--until": "value", "--author": "value", "-p": "bool", "--patch": "bool", "-U": "attached",
      "--unified": "attached", "--abbrev-commit": "bool", "--no-color": "bool", "--verbose": "bool",
      /** git status 의 추적 안 됨 표시 필터. 읽기 전용이다(저장소를 고치지 않는다). */
      "-u": "value", "--untracked-files": "attached", "--show-current": "bool",
      "-L": "value", "--merged": "bool", "--no-merged": "bool", "-l": "bool", "--list": "bool",
      "--abbrev-ref": "bool", "--show-toplevel": "bool", "-w": "bool", "--numstat": "bool",
      "--shortstat": "bool", "--reverse": "bool", "--first-parent": "bool", "--no-merges": "bool", "--tags": "bool", "--always": "bool", "--long": "bool",
      "--ignored": "attached",
    },
    positionals: "any",
    subPositionals: { branch: "none", tag: "none", remote: "none" },
    /** git이 실제로 다음 인자를 값으로 받는지는 서브커맨드마다 다르다. */
    subFlags: GIT_READ_SUB_FLAGS,
    subDeniedVerbs: GIT_READ_DENIED_VERBS,
    subVerbs: GIT_READ_VERBS,
    leadingFlags: ["--no-pager"],
    numericFlag: true,
    /** 검색어(-S, -G, --grep, git grep -e)는 셸 없이 그대로 넘기므로 block_patterns를 적용하지 않는다 */
    textFlags: ["--format", "--pretty", "-S", "-G", "--grep", "-e"],
  },
  find: {
    flags: {
      "-name": "value", "-iname": "value", "-type": "value", "-maxdepth": "value", "-mindepth": "value",
      "-path": "value", "-ipath": "value", "-size": "value", "-mtime": "value", "-mmin": "value",
      "-newer": "path", "-empty": "bool", "-print": "bool", "-print0": "bool", "-not": "bool",
      "-o": "bool", "-a": "bool", "-and": "bool", "-or": "bool", "-prune": "bool",
      "-P": "bool", "-user": "value", "-perm": "value", "-regex": "value", "-iregex": "value",
    },
    positionals: "path",
    singleDashLong: true,
    textFlags: ["-regex", "-iregex"],
  },
  curl: {
    flags: {
      "-s": "bool", "-S": "bool", "--silent": "bool", "--show-error": "bool", "-I": "bool",
      "--head": "bool", "-i": "bool", "--include": "bool", "-L": "bool", "--location": "bool",
      "-v": "bool", "-H": "value", "--header": "value", "-m": "value", "--max-time": "value",
      "--connect-timeout": "value", "-w": "value", "--write-out": "value", "-f": "bool",
      "--fail": "bool", "-k": "bool", "--compressed": "bool", "-A": "value", "--user-agent": "value",
      "-o": "value", "--output": "value",
    },
    positionals:  "url",
    /** 출력 파일은 버리는 경우(/dev/null)만 쓴다. 상태 코드만 볼 때(`-o /dev/null -w '%{http_code}'`) 쓴다. */
    allowedValues: { "-o": ["/dev/null"], "--output": ["/dev/null"] },
    fileRefFlags: ["-H", "--header", "-w", "--write-out"],
    deniedValues: { "-w": ["%output{"], "--write-out": ["%output{"] },
  },
  node:   { flags: { "--version": "bool", "-v": "bool" }, positionals: "none" },
  npx:    { flags: { "--version": "bool" }, positionals: "none" },
  npm:    { subcommands: ["ls", "list", "outdated", "view", "info", "audit", "--version", "-v"], flags: { "--depth": "value", "--json": "bool", "--all": "bool", "--omit": "value", "--prod": "bool", "--long": "bool", "--global": "bool", "-g": "bool" }, positionals: "any", subPositionals: { audit: "none" } },
  pnpm:   { subcommands: ["list", "ls", "outdated", "why", "info", "--version"], flags: { "--depth": "value", "--json": "bool", "--long": "bool", "--prod": "bool", "-P": "bool", "--dev": "bool", "-D": "bool", "-r": "bool", "--recursive": "bool", "--global": "bool", "-g": "bool" }, positionals: "any" },
  docker: { subcommands: ["ps", "images", "inspect", "logs", "version", "info", "stats"], flags: { "-a": "bool", "--all": "bool", "-q": "bool", "--format": "value", "--no-trunc": "bool", "--tail": "value", "--since": "value", "--no-stream": "bool", "-f": "value", "--filter": "value" }, positionals: "any", subFlags: { logs: { "-f": "bool" } } },
  kubectl: { subcommands: ["get", "describe", "logs", "version", "top", "explain", "api-resources", "cluster-info"], flags: { "-n": "value", "--namespace": "value", "-A": "bool", "--all-namespaces": "bool", "-o": "value", "--output": "value", "-l": "value", "--selector": "value", "--tail": "value", "--since": "value", "-c": "value", "--container": "value", "--context": "value", "-w": "bool", "--show-labels": "bool", "--previous": "bool" }, positionals: "any", allowedValues: { "-o": KUBECTL_OUTPUT_FORMATS, "--output": KUBECTL_OUTPUT_FORMATS } },
  helm:   { subcommands: ["list", "ls", "status", "history", "version"], flags: { "-n": "value", "--namespace": "value", "-A": "bool", "--all-namespaces": "bool", "-o": "value", "--output": "value", "-a": "bool", "--all": "bool" }, positionals: "any" },
  terraform: { subcommands: ["version"], flags: { "-json": "bool", "-no-color": "bool" }, positionals: "none", singleDashLong: true },
  cargo:  { subcommands: ["--version", "-V"], flags: {}, positionals: "none" },
  apt:    { subcommands: ["list", "show", "policy", "search"], flags: { "--installed": "bool", "--upgradable": "bool", "-a": "bool", "--all-versions": "bool" }, positionals: "any" },
  brew:   { subcommands: ["list", "info", "outdated", "--version", "search", "deps", "leaves", "config"], flags: { "--versions": "bool", "--formula": "bool", "--cask": "bool", "--json": "attached", "-1": "bool", "--tree": "bool" }, positionals: "any" },
  systemctl: { subcommands: ["list-units", "list-unit-files", "status", "is-active", "is-enabled", "is-failed", "show", "list-timers", "--version"], flags: { "--no-pager": "bool", "--type": "value", "-t": "value", "--state": "value", "--all": "bool", "-a": "bool", "--failed": "bool", "-p": "value", "--property": "value", "--plain": "bool", "--no-legend": "bool", "-l": "bool", "--full": "bool", "--user": "bool" }, positionals: "any" },
  journalctl: { flags: { "-u": "value", "--unit": "value", "-n": "count", "--lines": "count", "--since": "value", "--until": "value", "-p": "value", "--priority": "value", "-o": "value", "--output": "value", "--no-pager": "bool", "-b": "bool", "--boot": "bool", "-k": "bool", "--dmesg": "bool", "-r": "bool", "--reverse": "bool", "-q": "bool", "--user": "bool", "-g": "value", "--grep": "value" }, positionals: "none" },
  gh:     { subcommands: ["pr", "issue", "repo", "run", "release", "status", "--version"], flags: { "--json": "value", "-L": "value", "--limit": "value", "-s": "value", "--state": "value", "-R": "value", "--repo": "value", "-q": "value", "--jq": "value", "--author": "value", "--label": "value", "-w": "bool", "--web": "bool" }, positionals: "any", subVerbs: { pr: GH_READ_VERBS, issue: GH_READ_VERBS, repo: GH_READ_VERBS, run: GH_READ_VERBS, release: GH_READ_VERBS } },
};

/**
 * 기본 정책의 서브커맨드 목록에 항목을 더한 정책을 만든다.
 */
function extendSubcommands(base: CommandPolicy, extra: string[], overrides: Partial<CommandPolicy> = {}): CommandPolicy {
  return { ...base, ...overrides, subcommands: [...(base.subcommands ?? []), ...extra] };
}

/** cargo 조회 서브커맨드는 저장소 설정의 rustc 래퍼를 실행할 수 있으므로 build 프로필에서만 허용한다. */
const CARGO_QUERY_POLICY: CommandPolicy = {
  subcommands: ["--version", "-V", "tree", "metadata", "search", "pkgid"],
  flags:       { "--depth": "value", "--format-version": "value", "--no-deps": "bool", "-e": "value", "--edges": "value", "-i": "value", "--invert": "value" },
  positionals: "any",
};

const CARGO_BUILD_FLAGS: Record<string, FlagKind> = {
  ...bools(
    "--lib", "--bins", "--tests", "--examples", "--all-targets", "--workspace", "--release",
    "--all-features", "--no-default-features", "--no-fail-fast", "--locked", "--offline", "--frozen",
  ),
  "-p": "value", "--package": "value", "--bin": "value", "--test": "value", "--example": "value",
  "--features": "value", "-j": "value", "--jobs": "value", "--message-format": "value",
};

/** yarn 은 저장소가 지정한 yarnPath 스크립트를 실행하므로 build 프로필에서만 허용한다. */
const YARN_POLICY: CommandPolicy = {
  subcommands: ["list", "ls", "outdated", "why", "info", "--version"],
  flags:       { "--depth": "value", "--json": "bool", "--pattern": "value" },
  positionals: "any",
};

/**
 * build·ci 프로필의 git 정책. 기본 정책의 조회 서브커맨드에 로컬 저장소를 바꾸는 서브커맨드를 더한다.
 *
 * 넣지 않는 것:
 * - 대화형 실행(add -p, rebase -i, commit --interactive). 입력을 기다리며 멈춘다.
 * - 외부 프로그램을 지정하는 옵션(--upload-pack, --receive-pack, --exec, clone -u, clone -c/--config, --template).
 * - 원격을 바꾸는 서브커맨드(push, remote add·set-url·remove·rename). guard.allow_git_remote_write일 때만 더한다.
 * git config는 아래 GIT_CONFIG_KEYS로 시작하는 키만 받는다. 실행 프로그램을 가리키는 키(core.fsmonitor,
 * core.sshCommand, core.pager, core.editor, alias.* 등)는 바꾸지 못한다.
 */
const GIT_CONFIG_KEYS = [
  "user.name", "user.email", "init.defaultBranch", "core.autocrlf", "core.eol", "core.filemode", "core.ignorecase",
  "pull.rebase", "pull.ff", "merge.ff", "push.default", "push.autoSetupRemote", "branch.", "advice.", "color.",
  "safe.directory", "commit.gpgsign", "tag.gpgsign", "http.sslVerify", "receive.denyCurrentBranch",
];

const GIT_WRITE_SUBCOMMANDS = [
  "init", "add", "commit", "checkout", "switch", "restore", "stash", "merge", "rebase", "reset", "clean",
  "rm", "mv", "cherry-pick", "revert", "config", "clone", "fetch", "pull", "apply", "update-ref", "symbolic-ref", "gc",
];

const GIT_WRITE_FLAGS: Record<string, Record<string, FlagKind>> = {
  init:     { ...bools("-q", "--quiet", "--bare"), "-b": "value", "--initial-branch": "attached" },
  add:      { ...bools("-A", "--all", "-u", "--update", "-f", "--force", "-N", "--intent-to-add", "-v", "--verbose", "-n", "--dry-run", "--ignore-errors", "--renormalize") },
  commit:   {
    ...bools("-a", "--all", "--amend", "--no-edit", "--allow-empty", "--allow-empty-message", "-q", "--quiet", "-s", "--signoff",
      "--no-verify", "-n", "-v", "--verbose", "--no-gpg-sign", "--reset-author"),
    "-m": "value", "--message": "value", "--author": "value", "--date": "value", "-F": "path", "--file": "path", "-C": "value", "--fixup": "value",
  },
  checkout: { ...bools("-f", "--force", "-q", "--quiet", "--detach", "-t", "--track", "--no-track", "-m", "--merge", "--ours", "--theirs"), "-b": "value", "-B": "value", "--orphan": "value" },
  switch:   { ...bools("-f", "--force", "--discard-changes", "-q", "--quiet", "--detach", "-t", "--track", "--no-track", "-m", "--merge"), "-c": "value", "-C": "value", "--create": "value", "--force-create": "value", "--orphan": "value" },
  restore:  { ...bools("-S", "--staged", "-W", "--worktree", "-q", "--quiet", "--ours", "--theirs"), "-s": "value", "--source": "value" },
  stash:    { ...bools("-u", "--include-untracked", "-a", "--all", "-q", "--quiet", "-k", "--keep-index", "--index"), "-m": "value", "--message": "value" },
  merge:    { ...bools("--no-ff", "--ff-only", "--ff", "--squash", "--abort", "--continue", "--no-edit", "--no-commit", "-q", "--quiet", "--no-verify", "--allow-unrelated-histories"), "-m": "value", "--strategy": "value", "-s": "value", "-X": "value", "--strategy-option": "value" },
  rebase:   { ...bools("--abort", "--continue", "--skip", "-q", "--quiet", "--autostash", "--no-autostash", "--root"), "--onto": "value" },
  reset:    { ...bools("--hard", "--soft", "--mixed", "--keep", "--merge", "-q", "--quiet") },
  clean:    { ...bools("-f", "--force", "-d", "-x", "-X", "-n", "--dry-run", "-q", "--quiet"), "-e": "value", "--exclude": "value" },
  rm:       { ...bools("-r", "--cached", "-f", "--force", "-q", "--quiet", "-n", "--dry-run", "--ignore-unmatch") },
  mv:       { ...bools("-f", "--force", "-k", "-n", "--dry-run", "-v", "--verbose") },
  "cherry-pick": { ...bools("--abort", "--continue", "--skip", "-n", "--no-commit", "-x", "--no-edit", "--allow-empty"), "-m": "value", "--mainline": "value" },
  revert:   { ...bools("--abort", "--continue", "--skip", "-n", "--no-commit", "--no-edit"), "-m": "value", "--mainline": "value" },
  config:   { ...bools("--global", "--local", "--get", "--get-all", "--unset", "--unset-all", "--add", "--replace-all", "-l", "--list", "--bool", "--int", "--show-origin"), "--default": "value", "--type": "value" },
  clone:    { ...bools("-q", "--quiet", "--bare", "--single-branch", "--no-single-branch", "--no-tags", "--recurse-submodules", "--shallow-submodules", "-n", "--no-checkout", "--no-hardlinks", "-l", "--local"), "--depth": "value", "-b": "value", "--branch": "value", "--origin": "value", "-o": "value", "--filter": "value" },
  fetch:    { ...bools("--all", "--tags", "--no-tags", "-p", "--prune", "-q", "--quiet", "--unshallow", "-f", "--force"), "--depth": "value" },
  pull:     { ...bools("--rebase", "--no-rebase", "--ff-only", "--ff", "--no-ff", "--no-edit", "-q", "--quiet", "--all", "--tags", "--autostash", "--allow-unrelated-histories") },
  apply:    { ...bools("--check", "--stat", "--cached", "--index", "-R", "--reverse", "-3", "--3way", "-v", "--verbose", "--whitespace=fix") },
  fsck:     { ...bools("--unreachable", "--dangling", "--no-dangling", "--no-reflogs", "--full", "--connectivity-only", "--root", "--tags", "--cache", "--name-objects", "--lost-found") },
  "update-ref":   { ...bools("-d", "--no-deref", "--create-reflog", "--stdin", "-z"), "-m": "value" },
  reflog:   { ...bools("--all", "--stale-fix", "--rewrite", "--updateref", "--dry-run", "-n", "--verbose"), "--expire": "attached", "--expire-unreachable": "attached", "--date": "value" },
  gc:       { ...bools("--aggressive", "--auto", "-q", "--quiet", "--force", "--keep-largest-pack"), "--prune": "attached" },
  "symbolic-ref": { ...bools("-q", "--quiet", "--short", "--no-recurse", "-d", "--delete"), "-m": "value" },
  branch:   { ...bools("-d", "-D", "--delete", "-m", "-M", "--move", "-f", "--force", "-u", "--unset-upstream"), "--format": "value", "-t": "value", "--set-upstream-to": "attached" },
  tag:      { ...bools("-a", "--annotate", "-d", "--delete", "-f", "--force"), "--format": "value", "-n": "attached", "-m": "value", "--message": "value" },
};

const GIT_REMOTE_WRITE_FLAGS: Record<string, Record<string, FlagKind>> = {
  push:   { ...bools("-u", "--set-upstream", "--tags", "--all", "--mirror", "-f", "--force", "--force-with-lease", "-d", "--delete", "-q", "--quiet", "--no-verify", "--follow-tags", "-n", "--dry-run") },
  remote: { ...bools("-f", "--tags", "--no-tags") },
};

/** guard 설정을 반영한 build·ci 프로필 git 정책 */
export function buildGitPolicy(allowRemoteWrite: boolean): CommandPolicy {
  const base = DEFAULT_POLICIES.git!;
  const writeFlags = allowRemoteWrite ? { ...GIT_WRITE_FLAGS, ...GIT_REMOTE_WRITE_FLAGS } : GIT_WRITE_FLAGS;
  const remoteVerbs = ["show", "get-url", ...(allowRemoteWrite ? ["add", "set-url", "remove", "rm", "rename"] : [])];
  return {
    ...base,
    subcommands:    [...new Set([...base.subcommands!, ...GIT_WRITE_SUBCOMMANDS, ...(allowRemoteWrite ? ["push"] : [])])],
    subPositionals: { remote: "any", stash: "any" },
    /** stash는 조회 플래그와 쓰기 플래그를 합친다. */
    subFlags:       { ...base.subFlags, ...writeFlags, stash: { ...base.subFlags!.stash, ...writeFlags.stash } },
    subDeniedVerbs: {},
    subVerbs:       {
      remote:   remoteVerbs,
      stash:    ["push", "pop", "apply", "list", "show", "drop", "clear"],
      worktree: ["list", "add", "remove", "prune", "move", "lock", "unlock", "repair"],
    },
    optionalVerbs:  ["remote", "stash"],
    subPositionalPrefixes: { config: GIT_CONFIG_KEYS },
  };
}

/** build 또는 ci 프로필인지 */
export function isBuildProfile(guard: Pick<PrismGuardConfig, "profile">): boolean {
  return guard.profile === "build" || guard.profile === "ci";
}

/** 로컬 저장소 상태를 바꾸는 git 서브커맨드. 실행 뒤 _delta를 붙인다. */
export const GIT_MUTATING_SUBCOMMANDS = new Set([
  "init", "add", "commit", "checkout", "switch", "restore", "stash", "merge", "rebase", "reset", "clean",
  "rm", "mv", "cherry-pick", "revert", "pull", "apply", "branch", "tag", "update-ref", "symbolic-ref", "gc",
]);

/**
 * guard.profile이 "build"일 때 기본 정책 위에 덮어쓰는 정책.
 * 빌드·시험 실행에 필요한 서브커맨드만 더한다. 경로 위치 인자는 allowed_paths 검사를 그대로 받는다.
 */
export const BUILD_PROFILE_POLICIES: Record<string, CommandPolicy> = {
  npm:       extendSubcommands(DEFAULT_POLICIES.npm!, ["run", "test", "ci"]),
  pnpm:      extendSubcommands(DEFAULT_POLICIES.pnpm!, ["run", "test"]),
  yarn:      extendSubcommands(YARN_POLICY, ["run", "test"]),
  cargo:     extendSubcommands(CARGO_QUERY_POLICY, ["build", "test", "check"], {
    subPositionals: { build: "none", check: "none" },
    /**
     * 빌드와 시험 대상을 고르는 옵션과 진단 출력 형식. build, test, check는 이미 저장소의 빌드 스크립트를
     * 실행하므로 이 옵션들이 새 권한을 열지는 않는다. 출력 형식은 json만 받는다.
     */
    subFlags: Object.fromEntries(["build", "test", "check"].map(sub => [sub, CARGO_BUILD_FLAGS])),
    allowedValues: { "--message-format": ["json"] },
  }),
  terraform: extendSubcommands(DEFAULT_POLICIES.terraform!, ["show", "validate", "providers", "plan", "init"], {
    subPositionals: { show: "path" },
  }),
  node:      { flags: { "--version": "bool", "-v": "bool" }, positionals: "path", stopAtPositional: true },
  npx:       { flags: { "--version": "bool" }, positionals: "any", stopAtPositional: true },
  /**
   * build 프로필은 작업 공간에 파일을 쓰는 실행(git, npm, pip)을 이미 허용한다. curl도 내려받은 파일을 쓸 수 있게 하되
   * 출력 파일은 경로 인자로 보고 allowed_paths 검사를 받게 한다.
   */
  curl:      {
    ...DEFAULT_POLICIES.curl!,
    flags: { ...DEFAULT_POLICIES.curl!.flags, "-o": "path", "--output": "path", "-O": "bool", "--remote-name": "bool", "--create-dirs": "bool" },
    allowedValues: {},
  },
  docker:    extendSubcommands(DEFAULT_POLICIES.docker!, ["compose"], {
    subVerbs: { compose: ["ps", "logs"] },
    subFlags: { ...DEFAULT_POLICIES.docker!.subFlags, compose: { "-f": "path" } },
  }),
};

/**
 * 프로필과 설정을 반영한 명령별 유효 정책을 만든다.
 * 우선순위: guard.command_policies > build 프로필 > 기본 정책.
 * 결과는 프로토타입이 없는 객체라서 객체 프로토타입 키 이름의 명령은 정책을 갖지 않는다.
 */
export function resolvePolicies(guard: PrismGuardConfig): Record<string, CommandPolicy> {
  const build = isBuildProfile(guard);
  return Object.assign(
    Object.create(null) as Record<string, CommandPolicy>,
    DEFAULT_POLICIES,
    build ? BUILD_PROFILE_POLICIES : {},
    build ? { git: buildGitPolicy(guard.allow_git_remote_write === true) } : {},
    guard.command_policies ?? {},
  );
}

/** 정책 표에 명령이 자기 속성으로 정의돼 있는지 확인한다. */
export function hasPolicy(table: Record<string, CommandPolicy> | undefined, cmd: string): boolean {
  return table !== undefined && Object.hasOwn(table, cmd) && table[cmd] !== undefined;
}

/**
 * 명령의 유효 정책이 어느 계층에서 왔는지 반환한다. 정책이 없으면 undefined.
 */
export function policySource(guard: PrismGuardConfig, cmd: string): PolicySource | undefined {
  if (hasPolicy(guard.command_policies, cmd))                              return "config";
  if (isBuildProfile(guard) && (hasPolicy(BUILD_PROFILE_POLICIES, cmd) || cmd === "git")) return "build";
  if (hasPolicy(DEFAULT_POLICIES, cmd))                                    return "default";
  return undefined;
}

/**
 * git 실행 인자 앞에 두는 설정 덮어쓰기.
 * 저장소 설정이 지정한 fsmonitor, pager, hooks 경로, 서명 표시와 서명 검증 프로그램을 쓰지 않게 한다.
 */
const GIT_CONFIG_OVERRIDES = [
  "-c", "core.fsmonitor=false",
  "-c", "core.pager=cat",
  "-c", "core.hooksPath=/dev/null",
  "-c", "log.showSignature=false",
  "-c", "gpg.program=false",
  "-c", "gpg.ssh.program=false",
  "-c", "gpg.x509.program=false",
  /** 편집기를 기다리며 멈추지 않게 한다. 메시지 없는 commit은 빈 메시지로 중단되고, merge는 기본 메시지를 쓴다. */
  "-c", "core.editor=true",
  "-c", "sequence.editor=true",
];

/** 서브커맨드 뒤에 붙일 옵션. blame은 외부 diff 옵션을 받지 않으므로 textconv만 끈다. */
const GIT_SUBCOMMAND_OVERRIDES: Record<string, string[]> = {
  log:   ["--no-textconv", "--no-ext-diff", "--no-show-signature"],
  show:  ["--no-textconv", "--no-ext-diff", "--no-show-signature"],
  diff:  ["--no-textconv", "--no-ext-diff"],
  blame: ["--no-textconv"],
};

/** npx가 레지스트리에서 내려받지 않고 설치된 실행 파일만 실행하게 하는 옵션 */
const NPX_LOCAL_ONLY = ["--no"];

/**
 * ps 대시 옵션 낱말의 전체 선택 글자 e를 같은 뜻의 A로 바꾼다.
 * procps는 대시 옵션 해석이 실패하면 인자 전체를 BSD식으로 다시 읽는데, 그때 대시 낱말의 e는
 * 환경 변수를 함께 출력하는 수식어가 된다. A는 BSD식 해석에 없는 글자라 다시 읽기가 실패한다.
 * 값 플래그의 붙은 값과 다음 인자로 받은 값, 긴 옵션, 위치 인자는 그대로 둔다.
 */
function rewritePsSelectAll(args: string[], flags: Record<string, FlagKind>): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg.startsWith("--")) {
      out.push(arg);
      if (!arg.includes("=") && i + 1 < args.length && consumesNext(flags, arg, args[i + 1]!)) out.push(args[++i]!);
      continue;
    }
    if (!arg.startsWith("-")) {
      out.push(arg);
      continue;
    }
    let word      = "-";
    let valueFlag: string | undefined;
    for (let j = 1; j < arg.length; j++) {
      const kind = flagKind(flags, "-" + arg[j]);
      if (kind !== undefined && kind !== "bool") {
        word += arg.slice(j);
        if (j === arg.length - 1) valueFlag = "-" + arg[j];
        break;
      }
      word += arg[j] === "e" ? "A" : arg[j];
    }
    out.push(word);
    if (valueFlag && i + 1 < args.length && consumesNext(flags, valueFlag, args[i + 1]!)) out.push(args[++i]!);
  }
  return out;
}

/**
 * 실제 실행에 쓸 인자 배열을 만든다. 입력 배열은 변경하지 않는다.
 * git이면 저장소 설정의 fsmonitor·pager·hooks·서명 검증 프로그램을 끄는 -c 옵션을 맨 앞에 두고,
 * log·show·diff·blame 서브커맨드 뒤에는 textconv(및 외부 diff) 비활성 옵션을, log·show에는 서명 표시 비활성 옵션을 붙인다.
 * 서브커맨드 위치는 유효 git 정책의 leadingFlags를 건너뛰어 찾는다. guard가 없으면 기본 정책을 쓴다.
 * npx이면 맨 앞에 --no를 둔다. 표준 입력이 TTY가 아니면 npx는 설치 확인을 생략하므로
 * 이 옵션이 없으면 설치되지 않은 패키지를 내려받아 실행한다.
 * ps이면 유효 ps 정책의 플래그 표로 대시 옵션의 전체 선택 글자 e를 A로 바꾼다.
 */
export function buildExecArgs(cmd: string, args: string[], guard?: PrismGuardConfig): string[] {
  /**
   * npx(npm exec)는 패키지 이름 뒤의 `--noEmit` 같은 플래그를 npm 설정으로 읽어 버린다(실측: tsc가 --noEmit 없이 돌아
   * .js를 썼다). 실행할 명령 앞에 `--`를 두어 그 뒤의 인자가 모두 대상 명령에 가게 한다. npx 자신의 플래그(--version)는 그대로 둔다.
   */
  if (cmd === "npx") return args[0]?.startsWith("-") ? [...NPX_LOCAL_ONLY, ...args] : [...NPX_LOCAL_ONLY, "--", ...args];
  if (cmd === "ps") {
    const ps = guard ? resolvePolicies(guard).ps : DEFAULT_POLICIES.ps;
    return ps ? rewritePsSelectAll(args, ps.flags) : [...args];
  }
  if (cmd !== "git") return [...args];

  const policy  = guard ? resolvePolicies(guard).git : DEFAULT_POLICIES.git;
  const leading = policy?.leadingFlags ?? [];
  let   subIdx  = 0;
  while (subIdx < args.length && leading.includes(args[subIdx]!)) subIdx++;

  const sub   = args[subIdx] ?? "";
  const extra = Object.hasOwn(GIT_SUBCOMMAND_OVERRIDES, sub) ? GIT_SUBCOMMAND_OVERRIDES[sub] : undefined;
  if (!extra) return [...GIT_CONFIG_OVERRIDES, ...args];
  return [
    ...GIT_CONFIG_OVERRIDES,
    ...args.slice(0, subIdx + 1),
    ...extra,
    ...args.slice(subIdx + 1),
  ];
}
