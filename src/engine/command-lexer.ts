/**
 * 단일 문자열 명령 렉서.
 *
 * `command: "ps aux | grep node | head -n 5"` 같은 셸 문자열을 셸 없이 argv로 나눈다.
 * 셸을 띄우지 않으므로 셸이 해 주던 확장 가운데 안전한 것만 직접 한다.
 *
 *   따옴표       '...'는 글자 그대로, "..."는 \ " $ ` 만 이스케이프한다
 *   백슬래시     따옴표 밖의 \x는 x 한 글자다. 줄 끝의 \는 줄 잇기다
 *   물결표       따옴표 밖에서 낱말 맨 앞의 ~ 또는 ~/는 홈 디렉터리다
 *   글로브       따옴표 밖의 * ? [...]는 cwd 기준으로 펼친다. 맞는 파일이 없으면 글자 그대로 둔다
 *   주석         따옴표 밖에서 낱말 맨 앞의 #부터 끝까지는 버린다
 *
 * 받아들이는 구조:
 *
 *   [cd <dir> &&] <명령> [인자...] [2>&1 | 2>/dev/null] [| <필터> [인자...]]...
 *
 * 그 밖의 셸 문법(명령 치환, 변수 확장, 리다이렉션, 백그라운드, ;, &&, ||, 프로세스 치환,
 * 환경 변수 대입)은 실행하지 않고 unsupported_shell_operator로 거절한다. 거절 메시지에는 대안을 적는다.
 *
 * 작성자: 최진호
 * 작성일: 2026-11-12
 */

import { lstatSync, readdirSync } from "node:fs";
import { homedir }     from "node:os";
import path            from "node:path";

/** 렉서가 거절한 이유 */
export type LexErrorReason = "unsupported_shell_operator" | "unterminated_quote" | "empty_command";

export interface LexError {
  ok:      false;
  reason:  LexErrorReason;
  /** 거절한 연산자나 문법. 예: "$(", ">", "&&" */
  operator?: string;
  message: string;
  /** 같은 일을 Parism으로 하는 방법 */
  hint:    string;
}

/** 표준 오류 처리 방식. merge는 2>&1, discard는 2>/dev/null이다. */
export type StderrMode = "merge" | "discard";

export interface LexedCommand {
  ok:       true;
  cmd:      string;
  args:     string[];
  /** `cd <dir> &&` 접두로 바뀐 작업 디렉터리. 기준 cwd에 대한 상대 경로일 수 있다. */
  cwd?:     string;
  /** 파이프 뒤 단계의 argv. 첫 단계(cmd, args)는 들어가지 않는다. */
  pipeline: string[][];
  stderr?:  StderrMode;
  /** 렉서가 바꾼 것(글로브 펼침, 무시한 리다이렉션 등) */
  notes:    string[];
  /**
   * 첫 단계 인자마다 따옴표 밖의 글로브 패턴. 글로브가 없는 인자는 undefined다.
   * cwd가 정해진 뒤 expandGlobs가 펼치고 이 필드를 지운다.
   */
  globs?:   (string | undefined)[];
}

export type LexResult = LexedCommand | LexError;

/** 낱말 하나. glob은 따옴표 밖의 글로브 문자만 살린 패턴이다(따옴표 안의 글자는 \로 막는다). */
interface Word {
  kind:     "word";
  value:    string;
  /** 따옴표 밖에 글로브 문자가 있으면 펼칠 패턴 */
  glob?:    string;
  /** 낱말의 첫 글자가 따옴표 밖이었는지(물결표, 대입, 주석 판정용) */
  bareHead: boolean;
  /** 낱말 안에 따옴표 밖의 = 가 있고 그 앞이 변수 이름 형식인지 */
  assignment: boolean;
}

interface Operator {
  kind:  "op";
  value: string;
}

type Token = Word | Operator;

const GLOB_CHARS = new Set(["*", "?", "["]);

function reject(reason: LexErrorReason, operator: string | undefined, message: string, hint: string): LexError {
  return { ok: false, reason, ...(operator !== undefined && { operator }), message, hint };
}

const HINTS: Record<string, string> = {
  "$(":   "command substitution is not run. Run the inner command first and pass its output as an argument",
  "`":    "command substitution is not run. Run the inner command first and pass its output as an argument",
  "$":    "variables are not expanded. Write the value itself (for example the absolute path instead of $HOME)",
  "<(":   "process substitution is not run. Run each command separately and use compare_results or query_result",
  ">":    "output redirection is not run. The output is already returned; use query_result to keep and filter it",
  ">>":   "output redirection is not run. The output is already returned; use query_result to keep and filter it",
  "<":    "input redirection is not run. Pass the file path as an argument instead",
  "&":    "background jobs are not run. Use run with mode: \"task\" for long commands or mode: \"service\" for servers",
  ";":    "command lists are not run. Call run once per command",
  "&&":   "command chains are not run. Call run once per command; only a leading `cd <dir> &&` is accepted (it sets cwd)",
  "||":   "command chains are not run. Call run once per command and check ok in the result",
  "\n":   "several lines are several commands. Call run once per command",
  "=":    "environment assignments are not applied. Commands run with the server environment",
};

/**
 * 문자열을 토큰으로 나눈다. 연산자는 따로 토큰이 되고, 따옴표 안의 연산자 글자는 낱말에 남는다.
 */
function tokenize(input: string): Token[] | LexError {
  const tokens: Token[] = [];
  let value     = "";
  let glob      = "";
  let hasGlob   = false;
  let inWord    = false;
  let bareHead  = false;
  let sawEquals = false;
  let assignment = false;
  let i = 0;

  const startWord = (bare: boolean) => {
    if (!inWord) {
      inWord   = true;
      bareHead = bare;
    }
  };
  const flush = () => {
    if (!inWord) return;
    tokens.push({ kind: "word", value, ...(hasGlob && { glob }), bareHead, assignment });
    value = ""; glob = ""; hasGlob = false; inWord = false; bareHead = false; sawEquals = false; assignment = false;
  };
  const addLiteral = (ch: string) => {
    value += ch;
    glob  += GLOB_CHARS.has(ch) || ch === "\\" || ch === "]" ? `\\${ch}` : ch;
  };

  while (i < input.length) {
    const ch = input[i]!;

    if (ch === " " || ch === "\t") { flush(); i++; continue; }
    if (ch === "\n") {
      flush();
      if (input.slice(i + 1).trim() !== "") return reject("unsupported_shell_operator", "\n", "several lines were given", HINTS["\n"]!);
      i++;
      continue;
    }
    if (ch === "#" && !inWord) break;

    if (ch === "'") {
      startWord(false);
      const end = input.indexOf("'", i + 1);
      if (end < 0) return reject("unterminated_quote", "'", "a single quote is not closed", "close the quote");
      for (const c of input.slice(i + 1, end)) addLiteral(c);
      i = end + 1;
      continue;
    }

    if (ch === "\"") {
      startWord(false);
      i++;
      let closed = false;
      while (i < input.length) {
        const c = input[i]!;
        if (c === "\"") { closed = true; i++; break; }
        if (c === "\\" && i + 1 < input.length && "\\\"$`\n".includes(input[i + 1]!)) {
          if (input[i + 1] !== "\n") addLiteral(input[i + 1]!);
          i += 2;
          continue;
        }
        if (c === "`") return reject("unsupported_shell_operator", "`", "command substitution with backticks", HINTS["`"]!);
        if (c === "$" && i + 1 < input.length && /[A-Za-z_{(0-9?$@*#!-]/.test(input[i + 1]!)) {
          const op = input[i + 1] === "(" ? "$(" : "$";
          return reject("unsupported_shell_operator", op, op === "$(" ? "command substitution" : "variable expansion", HINTS[op]!);
        }
        addLiteral(c);
        i++;
      }
      if (!closed) return reject("unterminated_quote", "\"", "a double quote is not closed", "close the quote");
      continue;
    }

    if (ch === "\\") {
      if (i + 1 >= input.length) { i++; continue; }
      if (input[i + 1] === "\n") { i += 2; continue; }
      startWord(false);
      addLiteral(input[i + 1]!);
      i += 2;
      continue;
    }

    if (ch === "`") return reject("unsupported_shell_operator", "`", "command substitution with backticks", HINTS["`"]!);
    if (ch === "$" && i + 1 < input.length && /[A-Za-z_{(0-9?$@*#!-]/.test(input[i + 1]!)) {
      const op = input[i + 1] === "(" ? "$(" : "$";
      return reject("unsupported_shell_operator", op, op === "$(" ? "command substitution" : "variable expansion", HINTS[op]!);
    }

    /** 연산자 */
    const op = readOperator(input, i, inWord ? value : undefined, inWord && bareHead && /^[0-9]+$/.test(value) && glob === value);
    if (op) {
      if (op.fdPrefix) {
        value = ""; glob = ""; hasGlob = false; inWord = false; bareHead = false; sawEquals = false; assignment = false;
      } else {
        flush();
      }
      tokens.push({ kind: "op", value: op.value });
      i = op.end;
      continue;
    }

    startWord(true);
    if (ch === "=" && !sawEquals) {
      sawEquals  = true;
      assignment = bareHead && /^[A-Za-z_][A-Za-z0-9_]*$/.test(value);
    }
    if (GLOB_CHARS.has(ch)) {
      value  += ch;
      glob   += ch;
      hasGlob = true;
    } else {
      addLiteral(ch);
    }
    i++;
  }
  flush();
  return tokens;
}

/**
 * i 위치의 연산자를 읽는다. 연산자가 아니면 undefined.
 * fdNumber가 true면 바로 앞 낱말이 숫자 하나뿐이라 `2>` 같은 fd 접두로 볼 수 있다.
 */
function readOperator(
  input: string, i: number, current: string | undefined, fdNumber: boolean,
): { value: string; end: number; fdPrefix: boolean } | undefined {
  const rest = input.slice(i);
  const fd   = fdNumber ? current! : "";
  const make = (value: string, length: number, fdPrefix = false) => ({ value, end: i + length, fdPrefix });

  if (rest.startsWith(">&") || rest.startsWith("<&")) {
    const m = /^[<>]&([0-9]+|-)/.exec(rest);
    if (m) return make(`${fd}${m[0]}`, m[0].length, fdNumber);
  }
  if (rest.startsWith("&>>")) return make("&>>", 3);
  if (rest.startsWith("&>"))  return make("&>", 2);
  if (rest.startsWith(">>"))  return make(`${fd}>>`, 2, fdNumber);
  if (rest.startsWith(">|"))  return make(`${fd}>`, 2, fdNumber);
  if (rest.startsWith(">(") || rest.startsWith("<(")) return make(rest.slice(0, 2), 2);
  if (rest.startsWith(">"))   return make(`${fd}>`, 1, fdNumber);
  if (rest.startsWith("<<"))  return make("<<", 2);
  if (rest.startsWith("<"))   return make(`${fd}<`, 1, fdNumber);
  if (rest.startsWith("&&"))  return make("&&", 2);
  if (rest.startsWith("||"))  return make("||", 2);
  if (rest.startsWith("|&"))  return make("|&", 2);
  if (rest.startsWith("|"))   return make("|", 1);
  if (rest.startsWith("&"))   return make("&", 1);
  if (rest.startsWith(";"))   return make(";", 1);
  if (rest.startsWith("(") && current === undefined) return make("(", 1);
  return undefined;
}

/** 리다이렉션 연산자에서 fd 접두를 뺀 모양 */
function redirectKind(op: string): string | undefined {
  const m = /^([0-9]*)(>>|>|<|>&|<&)(.*)$/.exec(op);
  if (!m) return undefined;
  return m[2]!;
}

/** 물결표를 펼친다. 낱말 첫 글자가 따옴표 밖의 ~일 때만이다. */
function expandTilde(word: Word): Word {
  if (!word.bareHead) return word;
  if (word.value === "~") return { ...word, value: homedir(), glob: word.glob === undefined ? undefined : escapeGlob(homedir()) };
  if (word.value.startsWith("~/")) {
    const home = homedir();
    return {
      ...word,
      value: path.join(home, word.value.slice(2)),
      ...(word.glob !== undefined && { glob: escapeGlob(home) + word.glob.slice(1) }),
    };
  }
  return word;
}

function escapeGlob(text: string): string {
  return text.replace(/[*?[\]\\]/g, ch => `\\${ch}`);
}

/**
 * 토큰을 명령 구조로 묶는다. 받아들이지 않는 구조면 이유와 대안을 담은 거절을 돌려준다.
 */
export function lexCommand(input: string): LexResult {
  const tokens = tokenize(input);
  if (!Array.isArray(tokens)) return tokens;

  const notes: string[] = [];
  let   cwd: string | undefined;
  let   rest = tokens;

  /** 맨 앞의 `cd <dir> &&` 는 작업 디렉터리로 바꾼다. */
  while (rest.length >= 3 && rest[0]!.kind === "word" && rest[0]!.value === "cd"
    && rest[1]!.kind === "word" && rest[2]!.kind === "op" && rest[2]!.value === "&&") {
    const dir = expandTilde(rest[1] as Word).value;
    cwd  = cwd === undefined || path.isAbsolute(dir) ? dir : path.join(cwd, dir);
    notes.push(`leading 'cd ${dir} &&' set the working directory`);
    rest = rest.slice(3);
  }

  const stages: Word[][] = [[]];
  let   stderr: StderrMode | undefined;
  for (let i = 0; i < rest.length; i++) {
    const token = rest[i]!;
    if (token.kind === "word") {
      stages[stages.length - 1]!.push(token);
      continue;
    }
    const op = token.value;
    if (op === "|") {
      if (stages[stages.length - 1]!.length === 0) return reject("unsupported_shell_operator", "|", "a pipe has no command before it", HINTS[";"]!);
      stages.push([]);
      continue;
    }
    if (op === "|&") {
      stderr = "merge";
      notes.push("'|&' appended stderr after stdout for the next stage");
      stages.push([]);
      continue;
    }
    if (op === "2>&1") {
      if (stages.length > 1) return reject("unsupported_shell_operator", op, "2>&1 is accepted only on the first command", HINTS[">"]!);
      stderr = "merge";
      notes.push("2>&1 appended stderr after stdout (the original interleaving is not kept)");
      continue;
    }
    if (op === "2>" || op === "&>") {
      const target = rest[i + 1];
      if (op === "2>" && target?.kind === "word" && target.value === "/dev/null" && stages.length === 1) {
        stderr = "discard";
        notes.push("2>/dev/null dropped stderr from the result");
        i++;
        continue;
      }
      return reject("unsupported_shell_operator", op, `redirection '${op}' is not run`, HINTS[">"]!);
    }
    const kind = redirectKind(op);
    if (kind) return reject("unsupported_shell_operator", op, `redirection '${op}' is not run`, HINTS[kind] ?? HINTS[">"]!);
    if (op === ">(" || op === "<(") return reject("unsupported_shell_operator", op, "process substitution", HINTS["<("]!);
    if (op === "(") return reject("unsupported_shell_operator", op, "subshells are not run", HINTS[";"]!);
    return reject("unsupported_shell_operator", op, `'${op}' is not run`, HINTS[op] ?? HINTS[";"]!);
  }

  if (stages.some(stage => stage.length === 0)) {
    if (stages.length === 1) return reject("empty_command", undefined, "the command is empty", "give a command such as \"git status\"");
    return reject("unsupported_shell_operator", "|", "a pipe has no command after it", "add the filter after '|', or remove the trailing '|'");
  }

  for (const stage of stages) {
    const first = stage[0]!;
    if (first.assignment) {
      return reject("unsupported_shell_operator", "=", `environment assignment '${first.value}' is not applied`, HINTS["="]!);
    }
  }

  const [head, ...pipeline] = stages.map(stage => stage.map(expandTilde));
  return {
    ok:       true,
    cmd:      head![0]!.value,
    args:     head!.slice(1).map(w => w.value),
    ...(cwd !== undefined && { cwd }),
    pipeline: pipeline.map(stage => stage.map(w => w.value)),
    ...(stderr && { stderr }),
    notes,
    ...(head!.slice(1).some(w => w.glob !== undefined) && { globs: head!.slice(1).map(w => w.glob) }),
  };
}

/** 글로브 펼침 한 번에 돌려주는 최대 경로 수 */
const MAX_GLOB_MATCHES = 10_000;

/**
 * 첫 단계 인자의 글로브를 cwd 기준으로 펼친다. 맞는 경로가 없으면 글자 그대로 둔다(bash 기본 동작).
 * 숨김 파일은 패턴 조각이 .으로 시작할 때만 맞춘다.
 */
export function expandGlobs(lexed: LexedCommand, cwd: string): LexedCommand {
  const { globs, ...rest } = lexed;
  if (!globs) return rest;
  const args: string[] = [];
  const notes = [...lexed.notes];
  lexed.args.forEach((arg, index) => {
    const pattern = globs[index];
    if (pattern === undefined) { args.push(arg); return; }
    const matches = globPaths(pattern, cwd);
    if (matches.length === 0) {
      args.push(arg);
      return;
    }
    notes.push(`'${arg}' expanded to ${matches.length} path(s)`);
    args.push(...matches);
  });
  return { ...rest, args, notes };
}

/** 글로브 패턴 조각 하나를 정규식으로 바꾼다. \로 막은 글자는 글자 그대로다. */
function segmentRegex(segment: string): RegExp {
  let source = "";
  for (let i = 0; i < segment.length; i++) {
    const ch = segment[i]!;
    if (ch === "\\" && i + 1 < segment.length) { source += escapeRegex(segment[++i]!); continue; }
    if (ch === "*") { source += "[^/]*"; continue; }
    if (ch === "?") { source += "[^/]"; continue; }
    if (ch === "[") {
      const close = segment.indexOf("]", i + 2);
      if (close > i) {
        let body = segment.slice(i + 1, close);
        const negate = body.startsWith("!") || body.startsWith("^");
        if (negate) body = body.slice(1);
        source += `[${negate ? "^" : ""}${body.replace(/\\/g, "\\\\").replace(/\[/g, "\\[")}]`;
        i = close;
        continue;
      }
    }
    source += escapeRegex(ch);
  }
  return new RegExp(`^${source}$`);
}

function escapeRegex(ch: string): string {
  return /[.*+?^${}()|[\]\\/]/.test(ch) ? `\\${ch}` : ch;
}

function hasGlobMeta(segment: string): boolean {
  for (let i = 0; i < segment.length; i++) {
    if (segment[i] === "\\") { i++; continue; }
    if (GLOB_CHARS.has(segment[i]!)) return true;
  }
  return false;
}

function unescapeGlob(segment: string): string {
  return segment.replace(/\\(.)/g, "$1");
}

/** 글로브 패턴에 맞는 경로를 정렬해 돌려준다. 패턴이 상대 경로면 결과도 상대 경로다. */
function globPaths(pattern: string, cwd: string): string[] {
  const absolute = pattern.startsWith("/");
  const segments = pattern.split("/").filter((s, i) => s !== "" || i === 0);
  let   bases    = [absolute ? "/" : ""];
  for (const segment of absolute ? segments.slice(1) : segments) {
    if (segment === "") continue;
    const next: string[] = [];
    if (!hasGlobMeta(segment)) {
      const literal = unescapeGlob(segment);
      for (const base of bases) next.push(base === "" ? literal : path.posix.join(base, literal));
    } else {
      const re = segmentRegex(segment);
      const dotOk = segment.startsWith(".") || segment.startsWith("\\.");
      for (const base of bases) {
        let names: string[];
        try {
          names = readdirSync(path.resolve(cwd, base === "" ? "." : base));
        } catch {
          continue;
        }
        for (const name of names.sort()) {
          if (name.startsWith(".") && !dotOk) continue;
          if (re.test(name)) next.push(base === "" ? name : path.posix.join(base, name));
          if (next.length > MAX_GLOB_MATCHES) return [];
        }
      }
    }
    bases = next;
    if (bases.length === 0) return [];
  }
  /** 글로브가 아닌 조각으로 끝나면 그 경로가 실제로 있는 것만 남긴다. */
  return bases.filter(p => lstatSync(path.resolve(cwd, p), { throwIfNoEntry: false }) !== undefined);
}

/** 인자 하나를 셸에 다시 넣을 수 있게 따옴표로 감싼다(메시지와 _compiled_pipeline 표시용). */
export function quoteArg(arg: string): string {
  if (arg !== "" && /^[A-Za-z0-9_./:=@%+,-]+$/.test(arg)) return arg;
  return `'${arg.replace(/'/g, "'\\''")}'`;
}

/** 명령 목록의 한 조각과 그 앞의 연산자 */
export interface SequenceSegment {
  /** 앞 조각과 잇는 연산자. 첫 조각은 undefined다. */
  op?:  ";" | "&&" | "||";
  text: string;
}

/**
 * 명령 목록을 따옴표 밖의 `;`, `&&`, `||`, 줄바꿈으로 나눈다. 각 조각은 lexCommand로 다시 읽는다.
 * `>&`, `&>`의 &와 파이프 하나(|)는 조각 안에 남긴다. 닫히지 않은 따옴표가 있으면 undefined다.
 */
export function splitSequence(input: string): SequenceSegment[] | undefined {
  const segments: SequenceSegment[] = [];
  let current = "";
  let op: SequenceSegment["op"];
  let quote: "'" | "\"" | undefined;
  const push = (next: SequenceSegment["op"]) => {
    if (current.trim() !== "") segments.push({ ...(op && { op }), text: current.trim() });
    else if (next !== undefined && segments.length > 0) segments.push({ ...(op && { op }), text: "" });
    current = "";
    op = next;
  };
  for (let i = 0; i < input.length; i++) {
    const ch = input[i]!;
    if (quote) {
      current += ch;
      if (ch === "\\" && quote === "\"" && i + 1 < input.length) { current += input[++i]; continue; }
      if (ch === quote) quote = undefined;
      continue;
    }
    if (ch === "\\" && i + 1 < input.length) { current += ch + input[++i]; continue; }
    if (ch === "'" || ch === "\"") { quote = ch; current += ch; continue; }
    if (ch === "#" && (current === "" || /\s$/.test(current))) {
      while (i + 1 < input.length && input[i + 1] !== "\n") i++;
      continue;
    }
    if (ch === ";" || ch === "\n") { push(";"); continue; }
    if (ch === "&" && input[i + 1] === "&" && !current.endsWith(">")) { push("&&"); i++; continue; }
    if (ch === "|" && input[i + 1] === "|") { push("||"); i++; continue; }
    current += ch;
  }
  if (quote) return undefined;
  push(undefined);
  return segments.filter(s => s.text !== "" || s.op === undefined);
}

/**
 * `$?`, `${?}`, `${PIPESTATUS[N]}`, `$PIPESTATUS`를 값으로 바꾼다. 작은따옴표 안은 그대로 둔다.
 * 명령 목록을 차례로 실행할 때만 쓴다. 앞 조각의 종료 코드를 알기 때문이다.
 */
export function substituteStatus(text: string, last: number, pipeStatus: readonly number[]): string {
  let out = "";
  let single = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (ch === "'" ) single = !single;
    if (!single && ch === "$") {
      const rest = text.slice(i);
      const m = /^(\$\?|\$\{\?\}|\$\{PIPESTATUS\[([0-9]+)\]\}|\$\{PIPESTATUS\[@\]\}|\$PIPESTATUS)/.exec(rest);
      if (m) {
        out += m[2] !== undefined ? String(pipeStatus[Number(m[2])] ?? "") : m[0].includes("PIPESTATUS") ? (m[0].includes("@") ? pipeStatus.join(" ") : String(pipeStatus[0] ?? last)) : String(last);
        i += m[0].length - 1;
        continue;
      }
    }
    out += ch;
  }
  return out;
}
