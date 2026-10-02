/**
 * 내장 파서 계약.
 * 출력 모양(머리 줄, noise, 행 배열과 필드)과 출력 형식을 검증한 인자 범위를 명령별로 선언한다.
 * 허용 플래그는 실측으로 처리를 확인한 것만 둔다. 목록 밖의 플래그는 unsupported_format이며 raw와 native JSON 폴백은 그대로다.
 * 계약이 없는 명령(head, tail, cat, kill 등 형식과 무관한 파서, 이 호스트에서 실측하지 못한 명령)은 인자를 제한하지 않는다.
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 */

import type { ParserContract } from "./registry.js";
import type { FlagArity }      from "./format.js";
import { NUMBER_FLAG }         from "./format.js";
import { supportsGrep }     from "./text/grep.js";
import { lsHint, findHint, duHint, dfHint, psHint, ssHint, digHint, grepHint, envHint, freeHint, unameHint, idHint,
         journalctlHint, gitStatusHint, gitLogHint, gitBranchHint, dockerPsHint, kubectlHint, kubectlJsonHint, ghHint,
         ghPrListHint, npmListHint, npmHint } from "./hints.js";

/** 이름 목록을 같은 값 방식의 플래그 표로 만든다. */
function flags(arity: FlagArity, ...names: string[]): Record<string, FlagArity> {
  return Object.fromEntries(names.map(n => [n, arity]));
}
const bools  = (...names: string[]): Record<string, FlagArity> => flags("bool", ...names);
const values = (...names: string[]): Record<string, FlagArity> => flags("value", ...names);

const LS_FIELDS      = ["permissions", "links", "owner", "group", "size_bytes", "modified_at", "name", "type", "target"] as const;
const PS_FIELDS      = ["user", "pid", "cpu", "mem", "vsz", "rss", "tty", "stat", "start", "time", "command"] as const;
const SS_FIELDS      = ["netid", "state", "recv_q", "send_q", "local_address", "local_port", "peer_address", "peer_port"] as const;
const LSOF_FIELDS    = ["command", "pid", "user", "fd", "type", "device", "name", "state"] as const;
const DOCKER_PS      = ["container_id", "image", "command", "created", "status", "ports", "names"] as const;
const SYSTEMCTL_ROWS = ["name", "load", "active", "sub", "description", "job", "failed"] as const;

/** wc 카운터 플래그. 하나만 있어야 출력이 "수 파일" 두 열이다. */
const WC_COUNTERS = ["-l", "-w", "-c", "-m", "-L", "--lines", "--words", "--bytes", "--chars", "--max-line-length"];

/** ss 소켓 종류 필터 플래그 */
const SS_KINDS = ["t", "u", "w"];
const SS_LONG_KINDS = ["--tcp", "--udp", "--raw"];

/**
 * ss: Netid 열이 있고(종류 필터가 정확히 1개가 아님) 유닉스 소켓이 섞이지 않는 경우만 받는다.
 * 종류 필터가 없으면 -4, -6, -f inet 같은 인터넷 계열 지정이 있어야 유닉스 소켓이 빠진다.
 */
function supportsSsTable(args: string[]): boolean {
  const shorts = new Set(args.filter(a => /^-[A-Za-z0-9]+$/.test(a)).flatMap(a => [...a.slice(1)]));
  const kinds  = SS_KINDS.filter(c => shorts.has(c)).length + SS_LONG_KINDS.filter(n => args.includes(n)).length;
  const inet   = shorts.has("4") || shorts.has("6") || args.includes("--ipv4") || args.includes("--ipv6")
               || args.some((a, i) => /^(-f|--family)$/.test(a) && /^inet6?$/.test(args[i + 1] ?? "")) || args.some(a => /^--family=inet6?$/.test(a));
  return kinds !== 1 && (kinds >= 2 || inet);
}

/** 명령별 내장 계약 */
export const BUILTIN_CONTRACTS: Readonly<Record<string, ParserContract>> = {
  ls: {
    acceptedFlags: {
      ...bools("-l", "-n", "-a", "-A", "-t", "-r", "-S", "-1", "-d", "-U", "-X", "-v", "-c", "-u", "-k", "-N", "-B",
        "--all", "--almost-all", "--reverse", "--directory", "--numeric-uid-gid", "--ignore-backups", "--literal",
        "--kibibytes", "--group-directories-first"),
      ...values("-I", "--ignore", "--hide", "--sort", "--time", "--format"),
      "--color": "attached",
    },
    acceptedValues:      { "--format": /^(long|verbose)$/, "--color": /^(never|auto)$/ },
    requiredFlags:       ["-l", "-n", "--numeric-uid-gid", "--format"],
    acceptedPositionals: { max: 1 },
    hint:                lsHint,
    noise: /^total \d+|^\S.*:$/, rowsKey: "entries", rowFields: LS_FIELDS,
  },
  find: {
    acceptedFlags: {
      ...values("-name", "-iname", "-type", "-maxdepth", "-mindepth", "-path", "-ipath", "-size", "-mtime", "-mmin",
        "-newer", "-user", "-perm", "-regex", "-iregex"),
      ...bools("-empty", "-print", "-not", "-o", "-a", "-and", "-or", "-prune", "-P"),
    },
    singleDashLong: true,
    hint:           findHint,
    rowsKey: "paths",
  },
  stat: {
    acceptedFlags: bools("-L", "--dereference"),
  },
  du: {
    acceptedFlags: {
      ...bools("-s", "-h", "-a", "-c", "-k", "-m", "-b", "-x", "-S", "-H", "-D", "-P", "-l",
        "--summarize", "--human-readable", "--all", "--total", "--apparent-size", "--si", "--bytes", "--one-file-system",
        "--separate-dirs", "--count-links", "--dereference-args", "--no-dereference", "--inodes"),
      ...values("-d", "--max-depth", "--exclude", "-t", "--threshold", "-B", "--block-size"),
    },
    hint:    duHint,
    rowsKey: "entries", rowFields: ["size", "path"],
  },
  df: {
    acceptedFlags: {
      ...bools("-h", "-H", "-k", "-a", "-l", "-P", "--si", "--human-readable", "--all", "--local", "--portability", "--total", "--no-sync"),
      ...values("-t", "--type", "-x", "--exclude-type", "-B", "--block-size"),
    },
    acceptedValues: { "-B": /^(1K|1024)$/, "--block-size": /^(1K|1024)$/ },
    hint:           dfHint,
    headerLines: 1, rowsKey: "filesystems",
    rowFields: ["filesystem", "blocks_1k", "used", "available", "use_percent", "mounted_on"],
  },
  ps: {
    acceptedFlags:       { ...bools("-w", "--cumulative"), ...values("--sort", "--width") },
    acceptedPositionals: { min: 1, max: 1, pattern: /^[axw]*u[axw]*$/ },
    hint:                psHint,
    headerLines: 1, rowsKey: "processes", rowFields: PS_FIELDS,
  },
  ping: {
    acceptedFlags:       { ...bools("-q", "-n", "-4", "-6", "-D", "-O", "-v"), ...values("-c", "-i", "-W", "-w", "-s", "-t", "-I") },
    acceptedPositionals: { max: 1 },
  },
  curl: {
    acceptedFlags: {
      ...bools("-s", "-S", "--silent", "--show-error", "-I", "--head", "-k", "-f", "--fail", "--compressed", "-v"),
      ...values("-H", "--header", "-m", "--max-time", "--connect-timeout", "-A", "--user-agent"),
    },
    requiredFlags:       ["-I", "--head"],
    acceptedPositionals: { max: 1 },
  },
  netstat: {
    acceptedFlags: bools("-t", "-u", "-l", "-n", "-p", "-a", "-W", "-e", "-o", "-4", "-6",
      "--tcp", "--udp", "--listening", "--numeric", "--programs", "--all", "--wide", "--extend", "--timers"),
    acceptedPositionals: { max: 0 },
    headerLines: 2, rowsKey: "connections", rowLine: /^(tcp|udp)[46]?\s/i,
    rowFields: ["proto", "local_address", "foreign_address", "state"],
  },
  lsof: {
    acceptedFlags: { ...bools("-n", "-P", "-U", "-a", "-l", "-w", "-b"), ...flags("attached", "-i", "-s"), ...values("-d", "+D") },
    plusFlags:     true,
    headerLines: 1, rowsKey: "entries", rowFields: LSOF_FIELDS,
  },
  ss: {
    acceptedFlags: {
      ...bools("-t", "-u", "-w", "-l", "-n", "-a", "-p", "-4", "-6", "-r",
        "--tcp", "--udp", "--raw", "--listening", "--numeric", "--all", "--processes", "--ipv4", "--ipv6", "--resolve"),
      ...values("-f", "--family"),
    },
    acceptedValues:      { "-f": /^inet6?$/, "--family": /^inet6?$/ },
    acceptedPositionals: { max: 0 },
    supports:            supportsSsTable,
    hint:                ssHint,
    headerLines: 1, rowsKey: "connections", rowFields: SS_FIELDS,
  },
  dig: {
    acceptedFlags: { ...bools("+tcp", "+stats", "+nostats", "-4", "-6", "-m", "-r"), ...values("-x", "-t", "-c", "-p", "-q", "-b") },
    plusFlags:     true,
    hint:          digHint,
  },
  grep: {
    acceptedFlags: {
      ...bools("-r", "-R", "-n", "-l", "-L", "-b", "-Z", "-i", "-y", "-v", "-w", "-x", "-c", "-o", "-h", "-H", "-E", "-F", "-G", "-P", "-s", "-q", "-a", "-I", "-T",
        NUMBER_FLAG, "--recursive", "--line-number", "--files-with-matches", "--files-without-match", "--byte-offset", "--null", "--ignore-case", "--no-ignore-case", "--invert-match",
        "--word-regexp", "--line-regexp", "--count", "--only-matching", "--no-filename", "--with-filename", "--extended-regexp",
        "--fixed-strings", "--basic-regexp", "--perl-regexp", "--no-messages", "--quiet", "--silent", "--text", "--initial-tab"),
      ...values("-e", "--regexp", "-f", "--file", "-m", "--max-count", "-A", "-B", "-C", "--after-context", "--before-context", "--context", "--include", "--exclude", "--exclude-dir", "--exclude-from",
        "--binary-files", "--label", "-d", "--directories", "-D", "--devices"),
      ...flags("attached", "--color", "--colour"),
    },
    acceptedValues: { "--color": /^(never|auto|)$/, "--colour": /^(never|auto|)$/ },
    supports:       supportsGrep,
    hint:           grepHint,
    noise: /^--$/, rowsKey: "matches", rowFields: ["file", "line", "text", "byte_offset", "context"],
  },
  wc: {
    acceptedFlags:  { ...bools(...WC_COUNTERS), "--total": "attached" },
    requiredFlags:  WC_COUNTERS,
    exclusiveFlags: WC_COUNTERS,
    rowsKey: "entries", rowFields: ["count", "file"],
  },
  env:   { acceptedFlags: {}, acceptedPositionals: { max: 0 }, hint: envHint },
  pwd:   { acceptedFlags: bools("-L", "-P"), acceptedPositionals: { max: 0 } },
  which: { acceptedFlags: bools("-a", "-s"), rowsKey: "paths" },
  free: {
    acceptedFlags:       bools("-b", "-k", "-m", "-g", "-t", "-l", "-v", "--bytes", "--kibi", "--mebi", "--gibi", "--total", "--lohi", "--committed"),
    acceptedPositionals: { max: 0 },
    hint:                freeHint,
  },
  uname: { acceptedFlags: bools("-a", "--all"), requiredFlags: ["-a", "--all"], acceptedPositionals: { max: 0 }, hint: unameHint },
  id: {
    acceptedFlags:       bools("-u", "-g", "-G"),
    exclusiveFlags:      ["-u", "-g", "-G"],
    acceptedPositionals: { max: 1 },
    hint:                idHint,
  },
  systemctl: {
    leadingFlags: bools("--user", "--no-pager"),
    subcommands:  {
      "list-units": systemctlListUnits(),
      "":           systemctlListUnits(),
    },
    noise: /^\s*UNIT\s+LOAD\s|^Legend:|^\s*(LOAD|ACTIVE|SUB)\s+(=|->)|loaded units listed|^To show all/,
    rowsKey: "units", rowFields: SYSTEMCTL_ROWS,
  },
  journalctl: {
    acceptedFlags: {
      ...bools("--no-pager", "-b", "--boot", "-k", "--dmesg", "-r", "--reverse", "-q", "--quiet", "--user"),
      ...values("-o", "--output", "-u", "--unit", "-n", "--lines", "--since", "--until", "-p", "--priority", "-g", "--grep"),
    },
    acceptedValues:      { "-o": /^short-iso(-precise)?$/, "--output": /^short-iso(-precise)?$/ },
    requiredFlags:       ["-o", "--output"],
    acceptedPositionals: { max: 0 },
    hint:                journalctlHint,
    noise: /^-- No entries --$/, rowsKey: "entries", rowFields: ["timestamp", "hostname", "unit", "pid", "message"],
  },
  tasklist: { headerLines: 2 },
  dir: {
    acceptedFlags: {},
    supports:      () => process.platform === "win32",
  },
  kubectl: {
    subcommands: {
      "get pods":   kubectlGet(),
      "get events": kubectlGet(),
    },
    hint:        kubectlHint,
    headerLines: 1,
  },
  docker: {
    subcommands: {
      ps: {
        acceptedFlags:       { ...bools("-a", "--all", "--no-trunc", "-l", "--latest"), ...values("-f", "--filter", "-n", "--last") },
        acceptedPositionals: { max: 0 },
        hint:                dockerPsHint,
        rowsKey: "containers", rowFields: DOCKER_PS,
      },
    },
    headerLines: 1,
  },
  gh: {
    subcommands: {
      "pr list": {
        acceptedFlags:       values("--json", "-L", "--limit", "-s", "--state", "-R", "--repo", "--author", "--label"),
        acceptedPositionals: { max: 0 },
        hint:                ghPrListHint,
        rowsKey: "pull_requests",
      },
    },
    hint: ghHint,
  },
  helm: {
    subcommands: { list: helmList(), ls: helmList() },
    headerLines: 1,
  },
  apt: {
    subcommands: {
      list:   { acceptedFlags: bools("--installed", "--upgradable", "-a", "--all-versions") },
      search: { acceptedFlags: bools("--names-only") },
    },
    noise: /^(Listing|Sorting|Full Text Search|나열 중|정렬 중|전체 텍스트 검색 중)|^\s/, rowsKey: "packages", rowLine: /^[^\s/]+\/\S*\s/,
    rowFields: ["name", "suite", "version", "arch", "status", "description"],
  },
  npm: {
    subcommands: { ls: npmList(), list: npmList() },
    hint:        npmHint,
    rowsKey: "dependencies", rowLine: /^(?:[│| ] )*[├└+`][─-][─┬-] /, rowFields: ["name", "version", "depth", "deduped", "problem"],
  },
  cargo: { subcommands: {} },
  git: {
    leadingFlags: { ...bools("--no-pager"), ...values("-C", "-c", "--git-dir", "--work-tree", "--namespace") },
    subcommands:  {
      status: {
        acceptedFlags:  { ...bools("--long", "-v", "--verbose", "-b", "--branch"), ...flags("attached", "-u", "--untracked-files", "--ignored") },
        acceptedValues: { "--ignored": /^(traditional|)$/ },
        hint:           gitStatusHint,
      },
      log: {
        acceptedFlags: {
          ...bools("--oneline", "--all", "--no-merges", "--reverse", "--first-parent", "--abbrev-commit", "--no-decorate", "--no-color",
            "--tags", NUMBER_FLAG),
          ...values("-n", "--max-count", "--since", "--until", "--author"),
          ...flags("attached", "--format", "--pretty", "--decorate"),
        },
        acceptedValues: { "--format": /^(oneline|%h %s|%H %s)$/, "--pretty": /^(oneline|format:%h %s|format:%H %s)$/, "--decorate": /^(short|full|)$/ },
        requiredFlags:  ["--oneline", "--format", "--pretty"],
        hint:           gitLogHint,
        rowsKey: "commits", rowFields: ["hash", "message"],
      },
      branch: {
        acceptedFlags: bools("-v", "--verbose", "--no-abbrev", "--no-color", "--merged", "--no-merged", "--list", "-l", "-a", "--all", "-r", "--remotes"),
        requiredFlags: ["-v", "--verbose"],
        hint:          gitBranchHint,
        rowsKey: "branches", rowFields: ["current", "name", "hash", "upstream", "ahead", "behind", "message"],
      },
      diff: {
        acceptedFlags: {
          ...bools("--cached", "--staged", "-w", "--no-color", "-p", "--patch", "-M", "--no-renames", "--text", "-a", "--binary", "--no-prefix"),
          ...flags("attached", "-U", "--unified", "--diff-filter", "--find-renames"),
        },
        acceptedValues: { "--diff-filter": /^[ACDMRTUXB*acdmrtuxb]+$/, "--find-renames": /^\d*%?$/ },
        rowsKey: "files", rowLine: /^diff --git /, rowFields: ["path", "hunks"],
      },
    },
  },
};

/** systemctl 상태 필터 가운데 not-found 유닛을 포함하지 않는 값 */
const SYSTEMCTL_SAFE_STATE = /^(running|active|failed|exited)(,(running|active|failed|exited))*$/;

/**
 * systemctl list-units. --all과 그 밖의 상태 필터는 not-found 유닛에도 표시 기호를 붙여 failed로 오인되므로
 * 표시 기호를 없애는 --plain과 함께일 때만 받는다.
 */
function systemctlListUnits(): ParserContract {
  return {
    acceptedFlags: { ...bools("--failed", "--plain", "--no-pager", "-l", "--full", "--user", "--all", "-a"), ...values("--type", "-t", "--state") },
    supports:      args => args.includes("--plain") || !args.some((a, i) => a === "--all" || a === "-a"
      || (a.startsWith("--state=") && !SYSTEMCTL_SAFE_STATE.test(a.slice(8)))
      || (a === "--state" && !SYSTEMCTL_SAFE_STATE.test(args[i + 1] ?? ""))),
  };
}

/** kubectl get pods/events 표 형식 */
function kubectlGet(): ParserContract {
  return {
    acceptedFlags:  values("-n", "--namespace", "-l", "--selector", "--context", "-o", "--output"),
    acceptedValues: { "-o": /^wide$/, "--output": /^wide$/ },
    hint:           kubectlJsonHint,
  };
}

/** helm list 표 형식 */
function helmList(): ParserContract {
  return {
    acceptedFlags:       { ...bools("-a", "--all", "-A", "--all-namespaces"), ...values("-n", "--namespace", "-o", "--output") },
    acceptedValues:      { "-o": /^table$/, "--output": /^table$/ },
    acceptedPositionals: { max: 0 },
  };
}

/** npm ls 트리 형식 */
function npmList(): ParserContract {
  return {
    acceptedFlags:  { ...bools("--prod", "--long", "-g", "--global", "--all", "-a"), ...values("--depth", "--omit") },
    acceptedValues: { "--depth": /^\d+$/, "--omit": /^(dev|optional|peer)$/ },
    hint:           npmListHint,
  };
}
