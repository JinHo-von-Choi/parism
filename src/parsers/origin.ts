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

/**
 * 필드 한 개의 분류.
 * "external", "number"(유한한 수), "boolean", 또는 허용 문자열 목록(열거형)이다.
 * "external"이 아닌 값은 모두 fixed 분류이며 형식 검사를 받는다.
 */
export type FieldOrigin = "external" | "number" | "boolean" | readonly string[];

/**
 * 필드 경로 → 분류. 경로는 `passed`, `failures[].message`처럼 쓴다. `[]`는 배열의 모든 원소다.
 * 표에 없는 필드는 분류하지 않은 필드다.
 */
export type OriginTable = Readonly<Record<string, FieldOrigin>>;

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

const DU: OriginTable = { "entries[].size": "external", "entries[].path": "external", "entries[].modified_at": "external" };

/** 줄이나 경로 목록만 내는 파서. 내용이 전부 출력 그대로다. */
const LINES: OriginTable = { "lines[]": "external" };
const PATHS: OriginTable = { "paths[]": "external", ...SUMMARY };

const BY_COMMAND: Readonly<Record<string, OriginTable>> = {
  ls: LS, ps: PS, grep: GREP, stat: STAT, wc: WC, df: DF, du: DU,
  cat: LINES, head: LINES, tail: LINES, find: PATHS, which: PATHS,
  pwd: { path: "external" },
};

/** git 서브커맨드별 분류표. status는 출력 형식에 따라 둘로 나뉜다. */
function gitTable(args: readonly string[]): OriginTable | undefined {
  const sub = args.slice(skipLeadingFlags(BUILTIN_CONTRACTS.git!, [...args]));
  if (sub[0] === "status") return isPorcelainArgs(sub) ? GIT_STATUS_PORCELAIN : GIT_STATUS;
  if (sub[0] === "log")    return GIT_LOG;
  if (sub[0] === "branch") return GIT_BRANCH;
  return undefined;
}

/** cmd와 args로 실행한 결과에 적용되는 분류표. 분류표가 없는 파서면 undefined. */
export function originTableFor(cmd: string, args: readonly string[]): OriginTable | undefined {
  const runner = resolveRunner(cmd, args);
  if (runner) return runner.spec.rowsKey === "failures" ? TEST_REPORT : DIAGNOSTIC_REPORT;
  if (cmd === "git") return gitTable(args);
  if (cmd === "cargo" || cmd === "npx" || cmd === "go" || cmd === "ruff") return undefined;
  return Object.hasOwn(BY_COMMAND, cmd) ? BY_COMMAND[cmd] : undefined;
}

/** 분류표에서 external 필드의 경로 목록 */
export function externalFields(table: OriginTable): string[] {
  return Object.entries(table).filter(([, origin]) => origin === "external").map(([field]) => field);
}

/** 분류표에서 fixed 필드의 경로 목록 */
export function fixedFields(table: OriginTable): string[] {
  return Object.entries(table).filter(([, origin]) => origin !== "external").map(([field]) => field);
}

/** 경로가 가리키는 값을 모두 모은다. `[]` 조각은 배열의 모든 원소로 펼친다. 없는 필드는 건너뛴다. */
function valuesAt(root: unknown, fieldPath: string): unknown[] {
  let current: unknown[] = [root];
  for (const segment of fieldPath.split(".")) {
    const each = segment.endsWith("[]");
    const key  = each ? segment.slice(0, -2) : segment;
    const next: unknown[] = [];
    for (const value of current) {
      if (value === null || typeof value !== "object" || Array.isArray(value)) continue;
      const child = (value as Record<string, unknown>)[key];
      if (child === undefined) continue;
      if (each) {
        if (Array.isArray(child)) next.push(...child);
      } else {
        next.push(child);
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
