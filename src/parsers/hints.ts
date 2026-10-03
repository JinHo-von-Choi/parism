/**
 * 형식 밖의 인자에 대한 대체 인자 안내.
 * 각 함수는 서브커맨드 다음 인자(rest)를 받아, 같은 정보를 내장 파서나 native JSON 폴백이 처리하는
 * 인자로 바꾼 초안을 돌려준다. 같은 정보를 얻을 수 없으면 null이다.
 * 초안은 레지스트리가 형식 검사로 한 번 더 거른다(native 초안 제외).
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 */

import type { FlagArity, HintDraft } from "./format.js";
import { grepNeedsLineNumbers }       from "./text/grep.js";

type FlagTable = Readonly<Record<string, FlagArity>>;

function own(table: FlagTable, name: string): FlagArity | undefined {
  return Object.hasOwn(table, name) ? table[name] : undefined;
}

/**
 * args에서 drop 표의 플래그와 그 값을 뺀다. 단문자 묶음(-lhF)은 해당 글자만 뺀다.
 * known은 남는 플래그의 값 방식이며, 값을 받는 글자 뒤의 나머지와 다음 인자를 값으로 보존하는 데 쓴다.
 * "--" 뒤는 손대지 않는다.
 */
export function dropFlags(args: readonly string[], drop: FlagTable, known: FlagTable = {}): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--") { out.push(...args.slice(i)); break; }
    if (arg.length > 1 && (arg.startsWith("--") || arg.startsWith("+"))) {
      const eq   = arg.indexOf("=");
      const name = eq >= 0 ? arg.slice(0, eq) : arg;
      const kind = own(drop, name);
      if (kind) { if (kind === "value" && eq < 0) i++; continue; }
      out.push(arg);
      if (own(known, name) === "value" && eq < 0 && i + 1 < args.length) out.push(args[++i]!);
      continue;
    }
    if (!arg.startsWith("-") || arg === "-") { out.push(arg); continue; }

    const whole = own(drop, arg);
    if (whole) { if (whole === "value") i++; continue; }

    let kept      = "-";
    let dropNext  = false;
    let keepNext  = false;
    for (let j = 1; j < arg.length; j++) {
      const name    = `-${arg[j]}`;
      const dropped = own(drop, name);
      if (dropped === "bool") continue;
      if (dropped) { dropNext = dropped === "value" && j === arg.length - 1; break; }
      kept += arg[j];
      const kind = own(known, name);
      if (kind && kind !== "bool") {
        kept    += arg.slice(j + 1);
        keepNext = kind === "value" && j === arg.length - 1;
        break;
      }
    }
    if (kept !== "-") out.push(kept);
    if (dropNext) i++;
    else if (keepNext && i + 1 < args.length) out.push(args[++i]!);
  }
  return out;
}

/** 이름 가운데 하나라도 args에 있는지. 단문자 이름은 묶음 안의 글자도 본다. */
export function hasFlag(args: readonly string[], ...names: string[]): boolean {
  return names.some(n => n.startsWith("--")
    ? args.some(a => a === n || a.startsWith(`${n}=`))
    : args.some(a => a === n || (n.length === 2 && /^-[A-Za-z0-9]+$/.test(a) && a.includes(n[1]!))));
}

function table(arity: FlagArity, ...names: string[]): Record<string, FlagArity> {
  return Object.fromEntries(names.map(n => [n, arity]));
}

/* ---------------- ls ---------------- */

/** 표시만 바꾸는 ls 플래그. 빼도 긴 형식 목록의 정보는 같거나 늘어난다. */
const LS_DISPLAY: FlagTable = {
  ...table("bool", "-h", "--human-readable", "--si", "-F", "-p", "--file-type", "-Q", "--quote-name", "-b", "--escape",
    "-g", "-o", "-G", "--no-group", "--full-time", "-x", "-C", "-m", "-q", "--hide-control-chars"),
  ...table("value", "--time-style", "--quoting-style", "--indicator-style", "--block-size", "--format"),
  ...table("attached", "--color", "--classify", "--hyperlink"),
};
const LS_KNOWN: FlagTable = table("value", "-I", "--ignore", "--hide", "--sort", "--time", "-w", "--width", "-T", "--tabsize");

export function lsHint(rest: string[]): HintDraft | null {
  const args = dropFlags(rest, LS_DISPLAY, LS_KNOWN);
  if (!hasFlag(args, "-l", "-n", "--numeric-uid-gid")) args.push("-l");
  return { args, reason: "ls long listing (-l) is parsed; display-only flags are dropped" };
}

/* ---------------- grep ---------------- */

export function grepHint(rest: string[]): HintDraft | null {
  const known = table("value", "-e", "--regexp", "-f", "--file", "-m", "--max-count", "--include", "--exclude", "--exclude-dir",
    "--exclude-from", "--binary-files", "--label", "-d", "--directories", "-D", "--devices", "-A", "-B", "-C",
    "--after-context", "--before-context", "--context");
  const args = dropFlags(rest, table("bool", "-Z", "--null"), known);
  if (grepNeedsLineNumbers(args)) args.unshift("-n");
  return { args, reason: "grep output with line numbers (-n) and without NUL separators is parsed; the line number column separates file names that contain ':'" };
}

/* ---------------- df, free, uname, id ---------------- */

export function dfHint(rest: string[]): HintDraft | null {
  const args = dropFlags(rest, table("value", "-B", "--block-size"), table("value", "-t", "--type", "-x", "--exclude-type"));
  return { args, reason: "df columns in 1K blocks or human-readable sizes are parsed" };
}

const FREE_UNITS = ["-b", "-k", "-m", "-g", "--bytes", "--kibi", "--mebi", "--gibi"];

export function freeHint(rest: string[]): HintDraft | null {
  const args = dropFlags(rest, table("bool", "-h", "--human", "--si", "--kilo", "--mega", "--giga", "--tera", "--peta", "--tebi", "--pebi"));
  if (!hasFlag(args, ...FREE_UNITS)) args.push("-b");
  return { args, reason: "free counts in a binary unit are parsed exactly; -b gives bytes" };
}

export function unameHint(): HintDraft | null {
  return { args: ["-a"], reason: "uname -a output is parsed into every field" };
}

export function idHint(rest: string[]): HintDraft | null {
  return { args: rest.filter(a => !a.startsWith("-")), reason: "the full id output carries the same ids together with names" };
}

/* ---------------- dig ---------------- */

const DIG_DISPLAY = table("bool", "+short", "+noall", "+answer", "+nocomments", "+noquestion", "+nocmd", "+multi", "+multiline", "+yaml");

export function digHint(rest: string[]): HintDraft | null {
  return { args: dropFlags(rest, DIG_DISPLAY, table("value", "-x", "-t", "-c", "-p", "-q", "-b")), reason: "the default dig sections are parsed" };
}

/* ---------------- journalctl ---------------- */

export function journalctlHint(rest: string[]): HintDraft | null {
  const known = table("value", "-u", "--unit", "-n", "--lines", "--since", "--until", "-p", "--priority", "-g", "--grep");
  const args  = dropFlags(rest, { ...table("value", "-o", "--output"), ...table("bool", "--no-hostname") }, known);
  return { args: [...args, "-o", "short-iso"], reason: "journalctl -o short-iso output is parsed" };
}

/* ---------------- git ---------------- */

export function gitStatusHint(rest: string[]): HintDraft | null {
  const drop = { ...table("bool", "-s", "--short", "-z", "--null"), ...table("attached", "--porcelain", "--column") };
  return { args: dropFlags(rest, drop, table("attached", "-u", "--untracked-files", "--ignored")), reason: "the long format of git status is parsed" };
}

/** git log 고정 형식. 한 줄 형식(--oneline)이었으면 해시와 제목, 아니면 작성자와 작성 시각까지 탭으로 나눈다. */
const GIT_LOG_SUBJECT  = "--format=%h %s";
const GIT_LOG_AUTHORED = "--format=%h%x09%an%x09%aI%x09%s";

export function gitLogHint(rest: string[]): HintDraft | null {
  const drop    = { ...table("bool", "--oneline", "--graph"), ...table("attached", "--format", "--pretty", "--decorate", "--color") };
  const known   = table("value", "-n", "--max-count", "--since", "--until", "--author");
  const oneline = hasFlag(rest, "--oneline") || rest.some(a => /^--(format|pretty)=oneline$/.test(a));
  const deco    = rest.filter(a => a === "--decorate" || a.startsWith("--decorate=") || a === "--no-decorate").pop();
  if (oneline && deco !== undefined && deco !== "--no-decorate") {
    const args = dropFlags(rest, { ...table("bool", "--graph", "--no-decorate"), ...table("attached", "--decorate", "--color") }, known);
    return { args: [...args, "--decorate=full"], reason: "git log --oneline with full ref names (--decorate=full) is parsed; short ref names cannot be told apart from a parenthesized subject" };
  }
  return oneline
    ? { args: [...dropFlags(rest, drop, known), GIT_LOG_SUBJECT], reason: "git log with the fixed format '%h %s' (hash and subject) is parsed" }
    : { args: [...dropFlags(rest, drop, known), GIT_LOG_AUTHORED], reason: "git log with hash, author, ISO author date and subject separated by tabs is parsed" };
}

export function gitBranchHint(rest: string[]): HintDraft | null {
  const current = hasFlag(rest, "--show-current");
  const args    = dropFlags(rest, table("bool", "--show-current"));
  if (!hasFlag(args, "-v", "--verbose")) args.push("-v");
  return current
    ? { args, reason: "git branch -v marks the current branch with current: true (or lists the detached HEAD entry)" }
    : { args, reason: "git branch -v is parsed" };
}

/** 패치 대신 요약을 내는 git diff 옵션. 패치에 경로, 변경 종류, 바뀐 줄이 모두 있다. */
const GIT_DIFF_SUMMARY: FlagTable = {
  ...table("bool", "--numstat", "--shortstat", "--name-only", "--name-status", "--summary", "--compact-summary", "-z"),
  ...table("attached", "--stat", "--dirstat"),
};

export function gitDiffHint(rest: string[]): HintDraft | null {
  if (!hasFlag(rest, "--stat", "--numstat", "--shortstat", "--name-only", "--name-status", "--summary", "--compact-summary", "--dirstat")) return null;
  return {
    args:   dropFlags(rest, GIT_DIFF_SUMMARY),
    reason: "the git diff patch is parsed into files with path, change status, old path and hunks; the changed lines give the per-file counts",
  };
}

/* ---------------- systemctl, ps ---------------- */

/** 유닛 종류 접미사. 없으면 systemctl은 .service로 본다. */
const UNIT_SUFFIX = /\.(service|socket|target|device|mount|automount|swap|timer|path|slice|scope)$/;

/** systemctl status, is-active, is-failed: 이름 붙인 유닛의 상태를 list-units --all로 얻는다. */
export function systemctlHint(rest: string[]): HintDraft | null {
  const [verb, ...tail] = rest;
  if (!["status", "is-active", "is-failed"].includes(verb ?? "")) return null;
  const units = dropFlags(tail, table("bool", "--no-pager", "--user", "-l", "--full", "-q", "--quiet"));
  if (units.length === 0 || units.some(u => u.startsWith("-") || /^\d+$/.test(u))) return null;
  const kept = tail.filter(a => a === "--no-pager" || a === "--user");
  return {
    args:   ["list-units", "--all", ...units.map(u => (/[*?[]/.test(u) || UNIT_SUFFIX.test(u) ? u : `${u}.service`)), ...kept],
    reason: "systemctl list-units --all with the unit names gives their load, active and sub states",
  };
}

/** ps aux가 내는 열에 해당하는 -o 열 이름. comm(명령 이름)은 aux의 명령 줄 첫 낱말에 있다. */
const PS_AUX_COLUMNS = new Set(["pid", "user", "euser", "uname", "%cpu", "pcpu", "%mem", "pmem", "vsz", "vsize", "rss", "rssize", "rsz",
  "tty", "tt", "tname", "stat", "start", "bsdstart", "time", "cputime", "args", "cmd", "command", "comm", "ucmd", "ucomm"]);

/** ps -e, -A, ax(모든 프로세스)와 aux에 있는 열만 고른 -o: 같은 프로세스를 ps aux로 얻는다. */
export function psHint(rest: string[]): HintDraft | null {
  let   all  = false;
  const keep: string[] = [];
  const cols: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    if (["-e", "-A", "ax", "xa"].includes(a)) { all = true; continue; }
    if (a === "-eo" || a === "-Ao") { all = true; cols.push(...(rest[++i] ?? "").split(/[,\s]+/)); continue; }
    if (a === "-o" || a === "--format") { cols.push(...(rest[++i] ?? "").split(/[,\s]+/)); continue; }
    if (a.startsWith("--format=")) { cols.push(...a.slice(9).split(/[,\s]+/)); continue; }
    if (["--no-headers", "--headers", "-w"].includes(a) || a.startsWith("--sort=") || a.startsWith("--width=")) { keep.push(a); continue; }
    if ((a === "--sort" || a === "--width") && i + 1 < rest.length) { keep.push(a, rest[++i]!); continue; }
    return null;
  }
  if (!all || cols.some(c => c !== "" && !PS_AUX_COLUMNS.has(c.split("=")[0]!.toLowerCase()))) return null;
  return { args: ["aux", ...keep], reason: "ps aux lists the same processes with user, pid, CPU, memory, tty, state, start, time and the full command line" };
}

/* ---------------- docker, kubectl, gh, npm ---------------- */

export function dockerPsHint(rest: string[]): HintDraft | null {
  const args = dropFlags(rest, { ...table("bool", "-q", "--quiet"), ...table("value", "--format") }, table("value", "-f", "--filter", "-n", "--last"));
  return { args, reason: "the default docker ps table is parsed" };
}

/** kubectl get: 출력 형식 옵션을 -o json으로 바꾼다. */
export function kubectlJsonHint(rest: string[]): HintDraft | null {
  const known = table("value", "-n", "--namespace", "-l", "--selector", "-c", "--container", "--context", "--tail", "--since");
  const args  = dropFlags(rest, { ...table("value", "-o", "--output"), ...table("bool", "-w", "--watch", "--show-labels") }, known);
  return { args: [...args, "-o", "json"], reason: "kubectl -o json is returned as native JSON", native: true };
}

/** kubectl 서브커맨드 선언 밖의 get 실행 */
export function kubectlHint(rest: string[]): HintDraft | null {
  return rest[0] === "get" ? kubectlJsonHint(rest) : null;
}

/** gh 서브커맨드별 --json 필드 */
const GH_JSON_FIELDS: Readonly<Record<string, string>> = {
  "pr view":      "number,title,state,author,headRefName,body,isDraft",
  "issue list":   "number,title,state,author,labels,updatedAt",
  "issue view":   "number,title,state,author,labels,body",
  "repo view":    "name,owner,description,url,defaultBranchRef",
  "run list":     "databaseId,name,status,conclusion,headBranch,createdAt",
  "release list": "tagName,name,isLatest,publishedAt",
};
const GH_DISPLAY: FlagTable = { ...table("value", "-q", "--jq"), ...table("bool", "-w", "--web") };

/** gh 서브커맨드 선언 밖의 실행: --json 필드를 붙여 native JSON으로 받는다. */
export function ghHint(rest: string[]): HintDraft | null {
  const fields = GH_JSON_FIELDS[`${rest[0]} ${rest[1]}`];
  if (!fields || hasFlag(rest, "--json")) return null;
  return { args: [...dropFlags(rest, GH_DISPLAY), "--json", fields], reason: "gh --json output is returned as native JSON", native: true };
}

export function ghPrListHint(rest: string[]): HintDraft | null {
  return { args: dropFlags(rest, GH_DISPLAY), reason: "the gh pr list table and --json output are parsed" };
}

/** npm ls/list: --json으로 받는다. */
export function npmListHint(rest: string[]): HintDraft | null {
  if (hasFlag(rest, "--json")) return null;
  return { args: [...dropFlags(rest, table("bool", "--parseable", "-p")), "--json"], reason: "npm --json output is returned as native JSON", native: true };
}

/** npm 서브커맨드 선언 밖의 outdated, audit */
export function npmHint(rest: string[]): HintDraft | null {
  if (!["outdated", "audit"].includes(rest[0] ?? "") || hasFlag(rest, "--json")) return null;
  return { args: [...rest, "--json"], reason: "npm --json output is returned as native JSON", native: true };
}
