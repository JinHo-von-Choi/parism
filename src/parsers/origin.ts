/**
 * 필드 출처 분류.
 *
 * 파싱 결과의 각 필드를 "누가 정한 값인가"로 나눈다. 값의 형태(숫자인지 문자열인지)로 나누지 않는다.
 *
 *   fixed    -- Parism이 계산했거나, 정해진 값 집합 안에서만 나오는 값(개수, 크기, 상태 열거형)
 *   external -- 명령 출력에서 그대로 가져온 문자열(파일명, 경로, 브랜치명, 커밋 메시지, 로그 줄, 오류 메시지)
 *
 * 경로와 이름은 형태가 정해져 있어도 외부에서 정한 문자열이므로 external이다.
 * external 필드의 내용은 데이터이며 지시로 따를 대상이 아니다. 이 분류는 그 구분을 위한 단서를 준다.
 * stdout.raw, stderr, 근거 조회가 돌려주는 원문 구간은 분류와 관계없이 전부 external이다.
 *
 * 작성자: 최진호
 * 작성일: 2026-11-11
 */

import { resolveRunner }     from "./devloop/index.js";
import { isPorcelainArgs }   from "./git/status-porcelain.js";
import { skipLeadingFlags }  from "./format.js";
import { BUILTIN_CONTRACTS } from "./contracts.js";
import { singleValueFlag }   from "./system/id.js";
import { ipPack }            from "./network/ip.js";
import { vmstatPack }        from "./system/vmstat.js";
import { lsmodPack }         from "./system/lsmod.js";
import { lsusbPack }         from "./system/lsusb.js";
import { lspciPack }         from "./system/lspci.js";
import { lsblkPack }         from "./system/lsblk.js";
import { swaponPack }        from "./system/swapon.js";
import { lscpuPack }         from "./system/lscpu.js";
import { ipcsPack }          from "./system/ipcs.js";

/**
 * 필드 한 개의 분류.
 * "external", "number"(유한한 수), "boolean", 또는 허용 문자열 목록(열거형)이다.
 * "external"이 아닌 값은 모두 fixed 분류이며 형식 검사를 받는다.
 */
export type FieldOrigin = "external" | "number" | "boolean" | readonly string[];

/**
 * 필드 경로 → 분류. 경로는 `passed`, `failures[].message`처럼 쓴다. `[]`는 배열의 모든 원소다.
 * `*`는 객체의 모든 키다. 키 이름이 출력에서 오는 객체(`vars.*`, `headers.*`)에 쓴다.
 * external 경로는 그 아래의 값 전체를 가리킨다(`root.children[]`은 하위 트리 전체다).
 * 표에 없는 필드는 분류하지 않은 필드다.
 */
export type OriginTable = Readonly<Record<string, FieldOrigin>>;

/** 실패 × 변경 교차 귀속(engine/attribution.ts)이 붙이는 필드 */
function ATTRIBUTION(key: "failures" | "diagnostics"): OriginTable {
  return {
    [`${key}[].attribution`]:       ["modified_line", "modified_file", "unmodified"],
    [`${key}[].diff_hunk_preview`]: "external",
    [`${key}[].attribution_frame`]: "external",
    [`${key}[].imports_changed[]`]: "external",
    "attribution.modified_line":    "number",
    "attribution.modified_file":    "number",
    "attribution.unmodified":       "number",
    "attribution.changed_files":    "number",
  };
}

const TEST_REPORT: OriginTable = {
  "kind":                     ["test"],
  "tool":                     ["vitest", "jest", "cargo", "pytest", "go"],
  "passed":                   "number",
  "failed":                   "number",
  "skipped":                  "number",
  "todo":                     "number",
  "total":                    "number",
  "files_failed":             "number",
  "success":                  "boolean",
  "failures[].id":            "external",
  "failures[].file":          "external",
  "failures[].name":          "external",
  "failures[].line":          "number",
  "failures[].column":        "number",
  "failures[].message":       "external",
  "failures[].message_chars": "number",
  ...ATTRIBUTION("failures"),
};

const DIAGNOSTIC_REPORT: OriginTable = {
  "kind":                   ["diagnostics"],
  "tool":                   ["tsc", "eslint", "cargo", "ruff", "mypy"],
  "errors":                 "number",
  "warnings":               "number",
  "infos":                  "number",
  "files":                  "number",
  "diagnostics_omitted":    "number",
  "by_code[].code":         "external",
  "by_code[].count":        "number",
  "diagnostics[].file":     "external",
  "diagnostics[].line":     "number",
  "diagnostics[].column":   "number",
  "diagnostics[].severity": ["error", "warning", "info"],
  "diagnostics[].code":     "external",
  "diagnostics[].message":  "external",
  ...ATTRIBUTION("diagnostics"),
};

/**
 * 아래 표는 한 가지 규칙으로 만든다. 출력에서 그대로 가져온 문자열은 external이고,
 * 파서가 숫자나 불리언으로 바꾼 값과 파서가 정한 열거형은 fixed다.
 * 권한 문자열, 시각, 해시, 소유자 이름도 출력의 문자열 그대로이므로 external이다.
 */
const SUMMARY: OriginTable = { "_summary.total": "number", "_summary.shown": "number", "_summary.truncated": "boolean" };

const LS: OriginTable = {
  "entries[].permissions": "external",
  "entries[].links":       "number",
  "entries[].owner":       "external",
  "entries[].group":       "external",
  "entries[].size_bytes":  "number",
  "entries[].modified_at": "external",
  "entries[].name":        "external",
  "entries[].type":        ["file", "directory", "symlink", "char_device", "block_device", "other"],
  "entries[].target":      "external",
  "entries[].directory":   "external",
  ...SUMMARY,
};

const PS: OriginTable = {
  "processes[].user":    "external",
  "processes[].pid":     "number",
  "processes[].cpu":     "number",
  "processes[].mem":     "number",
  "processes[].vsz":     "number",
  "processes[].rss":     "number",
  "processes[].tty":     "external",
  "processes[].stat":    "external",
  "processes[].start":   "external",
  "processes[].time":    "external",
  "processes[].command": "external",
  "processes[].depth":   "number",
  ...SUMMARY,
};

const GIT_STATUS: OriginTable = {
  "branch":        "external",
  "staged[]":      "external",
  "modified[]":    "external",
  "untracked[]":   "external",
  "detached":      "boolean",
  "detached_at":   "external",
  "renamed[].old": "external",
  "renamed[].new": "external",
  "ignored[]":     "external",
  "unmerged[]":    "external",
};

const GIT_STATUS_PORCELAIN: OriginTable = {
  "entries[].xy":        "external",
  "entries[].index":     "external",
  "entries[].worktree":  "external",
  "entries[].path":      "external",
  "entries[].orig_path": "external",
  "entries[].quoted":    "boolean",
  "branch":              "external",
  "detached":            "boolean",
  ...SUMMARY,
};

const GIT_LOG: OriginTable = {
  "commits[].hash":    "external",
  "commits[].message": "external",
  "commits[].refs[]":  "external",
  "commits[].author":  "external",
  "commits[].date":    "external",
};

const GIT_BRANCH: OriginTable = {
  "branches[].current":       "boolean",
  "branches[].name":          "external",
  "branches[].hash":          "external",
  "branches[].upstream":      "external",
  "branches[].ahead":         "number",
  "branches[].behind":        "number",
  "branches[].message":       "external",
  "branches[].upstream_gone": "boolean",
  "branches[].worktree":      "boolean",
  "branches[].points_to":     "external",
  "branches[].detached":      "boolean",
};

const GREP: OriginTable = {
  "matches[].file":        "external",
  "matches[].line":        "number",
  "matches[].text":        "external",
  "matches[].byte_offset": "number",
  "matches[].context":     "boolean",
  ...SUMMARY,
};

const STAT: OriginTable = Object.fromEntries([
  ...["size_bytes", "blocks", "io_block", "inode", "links", "uid", "gid"].flatMap(f => [[f, "number"], [`files[].${f}`, "number"]]),
  ...["file", "file_type", "permissions", "uid_name", "gid_name", "accessed_at", "modified_at", "changed_at", "birth_at", "link_target"]
    .flatMap(f => [[f, "external"], [`files[].${f}`, "external"]]),
]) as OriginTable;

const WC: OriginTable = {
  "total":                     "number",
  "entries[].file":            "external",
  "entries[].count":           "number",
  "entries[].lines":           "number",
  "entries[].words":           "number",
  "entries[].chars":           "number",
  "entries[].bytes":           "number",
  "entries[].max_line_length": "number",
};

const DF: OriginTable = Object.fromEntries([
  ["block_size", "external"],
  ...["filesystem", "type", "blocks_1k", "size", "used", "available", "use_percent", "inodes_used", "inodes_free", "inodes_use_percent", "mounted_on"]
    .map(f => [`filesystems[].${f}`, "external"]),
]) as OriginTable;

const DU: OriginTable = { "entries[].size": "external", "entries[].size_bytes": "number", "entries[].path": "external", "entries[].modified_at": "external" };

/** 줄이나 경로 목록만 내는 파서. 내용이 전부 출력 그대로다. */
const LINES: OriginTable = { "lines[]": "external" };
const PATHS: OriginTable = { "paths[]": "external", ...SUMMARY };


/** 파서가 표로 읽지 못했을 때 내는 줄 목록과 원문 */
const FALLBACK: OriginTable = { "lines[]": "external", "raw": "external" };

/** 접두사 아래의 필드를 한 분류로 묶어 표를 만든다. */
function fields(prefix: string, origin: FieldOrigin, names: readonly string[]): OriginTable {
  return Object.fromEntries(names.map(name => [`${prefix}${name}`, origin]));
}

const TREE: OriginTable = {
  "root.name":       "external",
  "root.type":       ["file", "directory"],
  "root.children[]": "external",
  "directories":     "number",
  "files":           "number",
};

const PING: OriginTable = {
  ...fields("", "external", ["target", "target_ip"]),
  ...fields("", "number", ["packets_transmitted", "packets_received", "packet_loss_percent", "rtt_min_ms", "rtt_avg_ms", "rtt_max_ms"]),
};

function curlResponse(prefix: string): OriginTable {
  return {
    [`${prefix}status_code`]:        "number",
    [`${prefix}status_text`]:        "external",
    [`${prefix}headers.*`]:          "external",
    [`${prefix}header_values.*[]`]:  "external",
  };
}
const CURL: OriginTable = { ...curlResponse(""), ...curlResponse("history[]."), ...FALLBACK };

const NETSTAT: OriginTable = fields("connections[].", "external", ["proto", "local_address", "foreign_address", "state"]);

const LSOF: OriginTable = {
  ...fields("entries[].", "external", ["command", "user", "fd", "type", "device", "name", "state"]),
  "entries[].pid": "number",
};

const SS: OriginTable = {
  ...fields("connections[].", "external", ["netid", "state", "local_address", "local_port", "peer_address", "peer_port"]),
  ...fields("connections[].", "number", ["recv_q", "send_q"]),
};

function digQuery(prefix: string): OriginTable {
  return {
    ...fields(prefix, "external", ["query", "query_type", "server", "answers[].name", "answers[].type", "answers[].value"]),
    ...fields(prefix, "number", ["query_time_ms", "answers[].ttl"]),
    [`${prefix}answers[].class`]: ["IN", "CH", "HS"],
  };
}
const DIG: OriginTable = { ...digQuery(""), ...digQuery("queries[].") };

const FREE_ROW = [
  "total", "used", "free", "shared", "buff_cache", "available",
  "total_bytes", "used_bytes", "free_bytes", "shared_bytes", "buff_cache_bytes", "available_bytes",
] as const;
const FREE: OriginTable = {
  ...fields("mem.", "number", FREE_ROW),
  ...fields("swap.", "number", FREE_ROW),
  "unit": ["bytes", "giga", "mega", "kilo", "GB", "MB", "KB"],
};

const UNAME: OriginTable = fields("", "external", ["kernel_name", "hostname", "kernel_release", "kernel_version", "machine", "os", "raw"]);

const ID: OriginTable = {
  "uid": "number", "user": "external", "gid": "number", "group": "external",
  "groups[].id": "number", "groups[].name": "external",
};
/** `id -G`는 그룹 번호만 낸다. */
const ID_GROUP_NUMBERS: OriginTable = { "groups[]": "number" };

const SYSTEMCTL: OriginTable = {
  ...fields("units[].", "external", ["name", "load", "active", "sub", "description", "job"]),
  "units[].failed": "boolean",
  ...FALLBACK,
};

const JOURNALCTL: OriginTable = {
  ...fields("entries[].", "external", ["timestamp", "hostname", "unit", "message"]),
  "entries[].pid": "number",
  ...FALLBACK,
};

const DIR: OriginTable = {
  "directory":             "external",
  "entries[].name":        "external",
  "entries[].type":        ["file", "directory"],
  "entries[].size_bytes":  "number",
  "entries[].modified_at": "external",
  ...fields("", "number", ["total_files", "total_dirs", "free_bytes"]),
};

const TASKLIST: OriginTable = {
  ...fields("processes[].", "external", ["name", "session_name"]),
  ...fields("processes[].", "number", ["pid", "session_number", "mem_usage_kb"]),
};

const IPCONFIG: OriginTable = {
  ...fields("", "external", ["hostname", "dns_suffix"]),
  ...fields("adapters[].", "external", [
    "name", "description", "ipv4", "ipv6", "subnet_mask", "gateway", "dns_servers[]", "mac_address", "dhcp_server", "media_state",
  ]),
  "adapters[].dhcp_enabled": "boolean",
};

const SYSTEMINFO: OriginTable = {
  ...fields("", "external", [
    "hostname", "os_name", "os_version", "os_build", "os_manufacturer", "system_type", "processor", "domain", "logon_server",
    "hotfixes[]", "network_cards[]", "boot_device", "system_locale", "time_zone", "bios_version",
  ]),
  ...fields("", "number", ["total_memory_mb", "available_memory_mb"]),
};

const KUBECTL: OriginTable = {
  "resource": ["pods", "events"],
  ...fields("pods[].", "external", ["name", "status", "lastRestart", "age", "ip", "node"]),
  ...fields("pods[].", "number", ["ready.current", "ready.total", "restarts"]),
  ...fields("events[].", "external", ["last_seen", "type", "reason", "object", "message"]),
};

const DOCKER: OriginTable = {
  "resource": ["ps", "stats", "images"],
  ...fields("containers[].", "external", ["container_id", "image", "command", "created", "status", "ports", "names"]),
  ...fields("stats[].", "external", ["container_id", "name", "cpu_perc", "mem_usage", "mem_limit", "mem_perc", "net_io", "block_io"]),
  "stats[].pids": "number",
  ...fields("images[].", "external", ["repository", "tag", "image_id", "digest", "created", "size", "content_size"]),
};

const GH: OriginTable = {
  "resource": ["pr_list"],
  ...fields("pull_requests[].", "external", ["title", "branch", "state", "age", "author", "labels[]", "updated_at"]),
  "pull_requests[].number": "number",
  "pull_requests[].draft":  "boolean",
};

const HELM: OriginTable = {
  ...fields("releases[].", "external", ["name", "namespace", "updated", "status", "chart", "app_version"]),
  "releases[].revision": "number",
  ...FALLBACK,
};

const TERRAFORM: OriginTable = { ...fields("summary.", "number", ["to_add", "to_change", "to_destroy"]), ...FALLBACK };

const APT: OriginTable = { ...fields("packages[].", "external", ["name", "suite", "version", "arch", "status", "description"]), ...FALLBACK };

const BREW: OriginTable = { ...fields("packages[].", "external", ["name", "version"]), ...FALLBACK };

const NPM: OriginTable = {
  ...fields("dependencies[].", "external", ["name", "version", "problem"]),
  "dependencies[].depth":   "number",
  "dependencies[].deduped": "boolean",
  ...FALLBACK,
};

const CARGO_TREE: OriginTable = {
  ...fields("crates[].", "external", ["name", "version", "path", "source"]),
  "crates[].depth": "number",
  ...fields("crates[].", "boolean", ["deduped", "proc_macro"]),
  ...FALLBACK,
};

const GIT_DIFF: OriginTable = {
  "raw":              "external",
  "files_changed[]":  "external",
  "files[].path":     "external",
  "files[].old_path": "external",
  "files[].status":   ["modified", "added", "deleted", "renamed", "copied"],
  "files[].binary":   "boolean",
  ...fields("files[].hunks[].", "number", ["start_a", "count_a", "start_b", "count_b"]),
  "files[].hunks[].lines[]": "external",
  "_truncated":       "boolean",
  "_summary":         ["too large to parse"],
};

/** 스키마에서 분류표를 만들 때 읽는 Zod 정의의 일부 */
interface SchemaNode {
  _zod: { def: {
    type:       string;
    shape?:     Record<string, SchemaNode>;
    element?:   SchemaNode;
    innerType?: SchemaNode;
    entries?:   Record<string, unknown>;
    values?:    unknown[];
  } };
}

/**
 * ParserPack의 Zod 스키마에서 분류표를 만든다. 수와 불리언, 열거형과 문자열 리터럴은 fixed이고
 * 그 밖의 형(문자열, 문자열 합집합)은 external이다. 스키마가 이미 검사하는 형과 같은 기준이다.
 */
function tableFromSchema(node: SchemaNode, path = "", out: Record<string, FieldOrigin> = {}): Record<string, FieldOrigin> {
  const def = node._zod.def;
  if ((def.type === "optional" || def.type === "nullable") && def.innerType) return tableFromSchema(def.innerType, path, out);
  if (def.type === "object" && def.shape) {
    for (const [key, child] of Object.entries(def.shape)) tableFromSchema(child, path === "" ? key : `${path}.${key}`, out);
    return out;
  }
  if (def.type === "array" && def.element) return tableFromSchema(def.element, `${path}[]`, out);
  const literals = def.type === "enum" ? Object.values(def.entries ?? {}) : def.type === "literal" ? def.values ?? [] : undefined;
  if (def.type === "number" || def.type === "boolean") out[path] = def.type;
  else if (literals && literals.length > 0 && literals.every(v => typeof v === "string")) out[path] = literals as string[];
  else out[path] = "external";
  return out;
}

const PACK_TABLES: Readonly<Record<string, OriginTable>> = Object.fromEntries(
  [ipPack, vmstatPack, lsmodPack, lsusbPack, lspciPack, lsblkPack, swaponPack, lscpuPack, ipcsPack]
    .map(pack => [pack.name, tableFromSchema(pack.schema as unknown as SchemaNode)]),
);

const BY_COMMAND: Readonly<Record<string, OriginTable>> = {
  ...PACK_TABLES,
  ls: LS, ps: PS, grep: GREP, stat: STAT, wc: WC, df: DF, du: DU,
  cat: LINES, head: LINES, tail: LINES, find: PATHS, which: PATHS,
  pwd: { path: "external" },
  env: { "vars.*": "external" },
  kill: { raw: "external" },
  tree: TREE, ping: PING, curl: CURL, netstat: NETSTAT, lsof: LSOF, ss: SS, dig: DIG,
  free: FREE, uname: UNAME, systemctl: SYSTEMCTL, journalctl: JOURNALCTL,
  dir: DIR, tasklist: TASKLIST, ipconfig: IPCONFIG, systeminfo: SYSTEMINFO,
  kubectl: KUBECTL, docker: DOCKER, gh: GH, helm: HELM, terraform: TERRAFORM,
  apt: APT, brew: BREW, npm: NPM, pnpm: NPM, yarn: NPM, cargo: CARGO_TREE,
};

/** git 서브커맨드별 분류표. status는 출력 형식에 따라 둘로 나뉜다. */
function gitTable(args: readonly string[]): OriginTable | undefined {
  const sub = args.slice(skipLeadingFlags(BUILTIN_CONTRACTS.git!, [...args]));
  if (sub[0] === "status") return isPorcelainArgs(sub) ? GIT_STATUS_PORCELAIN : GIT_STATUS;
  if (sub[0] === "log")    return GIT_LOG;
  if (sub[0] === "branch") return GIT_BRANCH;
  if (sub[0] === "diff")   return GIT_DIFF;
  return undefined;
}

/** cmd와 args로 실행한 결과에 적용되는 분류표. 분류표가 없는 파서면 undefined. */
export function originTableFor(cmd: string, args: readonly string[]): OriginTable | undefined {
  const runner = resolveRunner(cmd, args);
  if (runner) return runner.spec.rowsKey === "failures" ? TEST_REPORT : DIAGNOSTIC_REPORT;
  if (cmd === "git") return gitTable(args);
  if (cmd === "id")  return singleValueFlag([...args]) === "G" ? ID_GROUP_NUMBERS : ID;
  return Object.hasOwn(BY_COMMAND, cmd) ? BY_COMMAND[cmd] : undefined;
}

/**
 * 분류표에서 이 결과에 해당하는 필드만 남긴다. 최상위 키가 결과에 없는 경로를 뺀다.
 * 한 파서가 형식에 따라 다른 모양을 내므로(`packages` 또는 `lines`), 표에는 모든 모양의 필드가 들어 있다.
 * 빈 배열 아래의 필드는 남는다. 호출자가 다음 실행에서 고를 필드를 미리 알 수 있어야 하기 때문이다.
 */
export function tableForResult(table: OriginTable, parsed: unknown): OriginTable {
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return table;
  const present = parsed as Record<string, unknown>;
  return Object.fromEntries(Object.entries(table).filter(([field]) => {
    const top = field.split(".")[0]!.replace(/\[\]$/, "");
    return top === "*" || present[top] !== undefined;
  }));
}

/** 분류표에서 external 필드의 경로 목록 */
export function externalFields(table: OriginTable): string[] {
  return Object.entries(table).filter(([, origin]) => origin === "external").map(([field]) => field);
}

/** 분류표에서 fixed 필드의 경로 목록 */
export function fixedFields(table: OriginTable): string[] {
  return Object.entries(table).filter(([, origin]) => origin !== "external").map(([field]) => field);
}

/** 경로가 가리키는 값을 모두 모은다. `[]` 조각은 배열의 모든 원소로, `*` 조각은 객체의 모든 값으로 펼친다. 없는 필드는 건너뛴다. */
function valuesAt(root: unknown, fieldPath: string): unknown[] {
  let current: unknown[] = [root];
  for (const segment of fieldPath.split(".")) {
    const each = segment.endsWith("[]");
    const key  = each ? segment.slice(0, -2) : segment;
    const next: unknown[] = [];
    for (const value of current) {
      if (value === null || typeof value !== "object" || Array.isArray(value)) continue;
      const children = key === "*" ? Object.values(value) : [(value as Record<string, unknown>)[key]];
      for (const child of children) {
        if (child === undefined) continue;
        if (each) {
          if (Array.isArray(child)) next.push(...child);
        } else {
          next.push(child);
        }
      }
    }
    current = next;
  }
  return current;
}

function conforms(value: unknown, origin: Exclude<FieldOrigin, "external">): boolean {
  /** null은 값이 없다는 뜻이고 외부 문자열을 담지 않는다. */
  if (value === null) return true;
  if (origin === "number")  return typeof value === "number" && Number.isFinite(value);
  if (origin === "boolean") return typeof value === "boolean";
  return typeof value === "string" && origin.includes(value);
}

/**
 * fixed 필드의 값이 분류표의 형식에 맞는지 검사한다. 어긋난 필드의 설명 목록을 돌려준다(최대 limit개).
 * 형식에 맞지 않는 값이 fixed 필드로 나가면 그 필드를 믿고 고른 호출자에게 외부 문자열이 섞여 들어간다.
 */
export function fixedViolations(parsed: unknown, table: OriginTable, limit = 3): string[] {
  const out: string[] = [];
  for (const [field, origin] of Object.entries(table)) {
    if (origin === "external") continue;
    for (const value of valuesAt(parsed, field)) {
      if (conforms(value, origin)) continue;
      out.push(`${field} is not ${Array.isArray(origin) ? `one of ${origin.join(", ")}` : `a ${origin as string}`}`);
      if (out.length >= limit) return out;
      break;
    }
  }
  return out;
}

/** 키가 이보다 많은 객체는 키 자체가 출력에서 온 것으로 보고(env의 변수 이름) 경로를 `*` 하나로 모은다. */
const DYNAMIC_KEY_LIMIT = 24;
/** 배열에서 형을 살펴보는 원소 수 상한 */
const ARRAY_SAMPLE = 200;

/**
 * 분류표가 없는 결과를 값의 형으로 분류한다.
 * 문자열은 external, 유한한 수와 불리언은 fixed다. 한 경로에 문자열이 하나라도 있으면 external이다.
 * 분류표와 같은 규칙이지만 파서가 정한 열거형을 알 수 없어 그런 문자열도 external이 된다.
 * 배열은 앞에서부터 ARRAY_SAMPLE개까지 본다. 시간 복잡도는 살펴본 값의 수에 선형이다.
 */
export function deriveOrigin(parsed: unknown): { external: string[]; fixed: string[] } {
  const kinds = new Map<string, "external" | "fixed">();
  const note  = (path: string, kind: "external" | "fixed"): void => {
    if (kinds.get(path) !== "external") kinds.set(path, kind);
  };
  const walk = (value: unknown, path: string): void => {
    if (typeof value === "string") { note(path, "external"); return; }
    if (typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value))) { note(path, "fixed"); return; }
    if (Array.isArray(value)) {
      for (const item of value.slice(0, ARRAY_SAMPLE)) walk(item, `${path}[]`);
      return;
    }
    if (value === null || typeof value !== "object") return;
    const entries = Object.entries(value);
    const dynamic = entries.length > DYNAMIC_KEY_LIMIT;
    for (const [key, child] of entries) walk(child, dynamic ? `${path === "" ? "" : `${path}.`}*` : path === "" ? key : `${path}.${key}`);
  };
  walk(parsed, "");
  const paths = [...kinds].filter(([path]) => path !== "");
  return {
    external: paths.filter(([, kind]) => kind === "external").map(([path]) => path),
    fixed:    paths.filter(([, kind]) => kind === "fixed").map(([path]) => path),
  };
}
