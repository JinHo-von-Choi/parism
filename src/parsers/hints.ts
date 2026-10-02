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

/* ---------------- find, du, grep, env: NUL separators ---------------- */

export function findHint(rest: string[]): HintDraft | null {
  if (!rest.includes("-print0")) return null;
  return { args: rest.filter(a => a !== "-print0"), reason: "newline-separated find output is parsed" };
}

export function duHint(rest: string[]): HintDraft | null {
  const known = table("value", "-d", "--max-depth", "--exclude", "-t", "--threshold", "-B", "--block-size");
  return { args: dropFlags(rest, table("bool", "-0", "--null"), known), reason: "newline-separated du output is parsed" };
}

export function grepHint(rest: string[]): HintDraft | null {
  const known = table("value", "-e", "--regexp", "-f", "--file", "-m", "--max-count", "--include", "--exclude", "--exclude-dir",
    "--exclude-from", "--binary-files", "--label", "-d", "--directories", "-D", "--devices", "-A", "-B", "-C",
    "--after-context", "--before-context", "--context");
  const args    = dropFlags(rest, table("bool", "-Z", "--null"), known);
  const context = hasFlag(args, "-A", "-B", "-C", "--after-context", "--before-context", "--context") || args.some(a => /^-\d+$/.test(a));
  if (context && !hasFlag(args, "-n", "--line-number")) args.unshift("-n");
  return { args, reason: "grep output with line numbers (-n) and without NUL separators is parsed" };
}

export function envHint(rest: string[]): HintDraft | null {
  return { args: dropFlags(rest, table("bool", "-0", "--null")), reason: "newline-separated env output is parsed" };
}

/* ---------------- df, free, uname, id ---------------- */

export function dfHint(rest: string[]): HintDraft | null {
  const args = dropFlags(rest, { ...table("bool", "-m"), ...table("value", "-B", "--block-size") }, table("value", "-t", "--type", "-x", "--exclude-type"));
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

/* ---------------- ps, dig ---------------- */

export function psHint(rest: string[]): HintDraft | null {
  const args = dropFlags(rest, table("bool", "--forest", "--no-headers", "--headers"), table("value", "--sort", "--width"))
    .map(a => (/^[A-Za-z]+$/.test(a) ? a.replace(/f/g, "") : a));
  return { args, reason: "BSD user format (ps aux) without the process tree is parsed" };
}

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
  const drop = { ...table("bool", "-s", "--short", "-z", "--null"), ...table("attached", "--porcelain", "--column", "--ignored") };
  return { args: dropFlags(rest, drop, table("attached", "-u", "--untracked-files")), reason: "the long format of git status is parsed" };
}

export function gitLogHint(rest: string[]): HintDraft | null {
  const drop  = { ...table("bool", "--oneline", "--graph"), ...table("attached", "--format", "--pretty", "--decorate", "--color") };
  const known = table("value", "-n", "--max-count", "--since", "--until", "--author");
  return { args: [...dropFlags(rest, drop, known), "--format=%h %s"], reason: "git log with the fixed format '%h %s' (hash and subject) is parsed" };
}

export function gitBranchHint(rest: string[]): HintDraft | null {
  if (hasFlag(rest, "-v", "--verbose")) return null;
  return { args: [...rest, "-v"], reason: "git branch -v is parsed" };
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
