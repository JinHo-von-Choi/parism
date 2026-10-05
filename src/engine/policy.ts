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

const COMMON_GIT_READ = ["status", "log", "diff", "show", "branch", "rev-parse", "ls-files", "blame", "describe", "shortlog", "tag", "remote"];

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
  echo:  { flags: bools("-n", "-e", "-E"), positionals: "any", textPositionals: true },
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
    subFlags: {
      branch:   { "--format": "value" },
      tag:      { "--format": "value", "-n": "attached" },
      blame:    { "-n": "bool" },
      shortlog: { "-n": "bool" },
    },
    leadingFlags: ["--no-pager"],
    numericFlag: true,
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

/** yarn 은 저장소가 지정한 yarnPath 스크립트를 실행하므로 build 프로필에서만 허용한다. */
const YARN_POLICY: CommandPolicy = {
  subcommands: ["list", "ls", "outdated", "why", "info", "--version"],
  flags:       { "--depth": "value", "--json": "bool", "--pattern": "value" },
  positionals: "any",
};

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
  }),
  terraform: extendSubcommands(DEFAULT_POLICIES.terraform!, ["show", "validate", "providers", "plan", "init"], {
    subPositionals: { show: "path" },
  }),
  node:      { flags: { "--version": "bool", "-v": "bool" }, positionals: "path", stopAtPositional: true },
  npx:       { flags: { "--version": "bool" }, positionals: "any", stopAtPositional: true },
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
  return Object.assign(
    Object.create(null) as Record<string, CommandPolicy>,
    DEFAULT_POLICIES,
    guard.profile === "build" ? BUILD_PROFILE_POLICIES : {},
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
  if (guard.profile === "build" && hasPolicy(BUILD_PROFILE_POLICIES, cmd)) return "build";
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
  if (cmd === "npx") return [...NPX_LOCAL_ONLY, ...args];
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
