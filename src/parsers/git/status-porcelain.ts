/**
 * `git status --porcelain=v1 -z` 파서.
 *
 * 이 형식이 머신 판독용 정본인 이유를 먼저 적어 둔다.
 * 줄 구분 출력은 경로에 C 스타일 이스케이프와 따옴표를 넣는다. 실제로 파일 이름에 개행 문자가 있으면
 * `?? "line\nbreak.txt"` 처럼 표시되어 원래 이름과 다르다. `-z` 는 그런 가공 없이 경로를 그대로 내고
 * NUL 로 레코드를 나누므로 개행이 든 파일 이름도 한 레코드로 온다.
 *   - 실측: 개행 구분 모드는 `?? "line\nbreak.txt"`, -z 모드는 `?? line<LF>break.txt` (따옴표 없음)
 *
 * 레코드 형식: `XY<SP>PATH<NUL>`. 이름 변경·복사(XY 에 R 또는 C 가 있을 때)는 원래 경로가
 * 다음 NUL 레코드로 따로 온다. 순서는 **새 경로가 먼저**, 원래 경로가 뒤다.
 *   - 실측: `RM renamed.txt<NUL>keep.txt<NUL>`
 *
 * `--branch` 를 함께 주면 맨 앞에 `## <브랜치>` 레코드가 온다.
 *
 * `-z` 를 **안 쓰면** 레코드가 개행으로 나뉘고 경로에 C 스타일 이스케이프와 따옴표가 들어간다.
 * 이때 이름 변경은 `XY <원래경로> -> <새경로>` 한 줄로 온다(별도 레코드가 아니다).
 * 그래서 레코드 경계와 경로 해석을 두 형식마다 따로 한다 — 한 규칙으로 둘 다 읽으면 둘 중 하나를 반드시 놓친다.
 *   - 실측: `-z` 없음 `RM keep.txt -> renamed.txt` + `?? "line\nbreak.txt"`, `-z` 있음 `RM renamed.txt<NUL>keep.txt<NUL>` + `?? line<LF>break.txt<NUL>`
 *
 * 작성자: 최진호
 * 작성일: 2026-10-05
 */

import type { RawEvidence, RawSpan } from "../../engine/evidence.js";
import { readQuotedToken } from "./paths.js";

export interface GitStatusEntry {
  /** 두 자리 상태를 그대로 둔다. 예: " M", "??", "RM", "UU" */
  xy:        string;
  /** 스테이징 영역 상태 문자(첫째 글자) */
  index:     string;
  /** 워크트리 상태 문자(둘째 글자) */
  worktree:  string;
  /** 경로. 원래 이름이며, -z 형식이면 가공이 없고 줄 구분 형식이면 따옴표·이스케이프를 풀었다 */
  path:      string;
  /** 이름이 바뀌거나 복사된 항목의 원래 경로 */
  orig_path?: string;
  /** 경로를 표시할 때 C 이스케이프와 따옴표가 들어갔는지(-z 가 아닐 때만 true가 될 수 있다) */
  quoted?:   boolean;
}

export interface GitStatusPorcelainSummary {
  total:     number;
  shown:     number;
  truncated: boolean;
}

export interface GitStatusPorcelain {
  entries:  GitStatusEntry[];
  branch?:  string;
  detached?: true;
  _summary?: GitStatusPorcelainSummary;
}

/** 레코드는 NUL 로 나뉘므로 줄 번호가 통하지 않는다. line=0 은 '원문 전체 기준 절대 오프셋'을 뜻한다. */
const ABSOLUTE = 0;

/** 상태 두 글자 뒤에 공백 하나가 오고 그다음이 경로다 */
/**
 * 상태 두 자리 뒤에 구분 공백 하나가 오고 그다음이 경로다.
 * 스테이징 안 됨은 공백으로 온다(" M file" = 워크트리만 수정). 공백을 상태 문자로 받아야 한다.
 * 실측: ` M src/a.ts` 는 " " + "M" + 구분 공백 + 경로 다섯 글자다.
 */
const RECORD = /^([A-Z?! ])([A-Z?! ]) (.*)$/s;

function span(
  record: number, start: number, end: number, transform?: string,
): RawSpan {
  return { source: "stdout", line: ABSOLUTE, start, end, record, ...(transform && { transform }) };
}

/** `-z` / `--null` 로 NUL 레코드 출력을 요청했는지 */
function usesNulRecords(args: string[]): boolean {
  return args.some(a => a === "-z" || a === "--null");
}

/**
 * 레코드의 경로 자리 한 개를 [start, end) 구간에서 읽는다.
 * 따옴표로 감싸였으면 C 이스케이프를 풀고, 아니면 구간 전체를 그대로 읽는다.
 * start 는 원문(따옴표 포함) 기준 위치, rawLength 는 원문에서 차지하는 길이다.
 * 따옴표가 구간을 벗어나면 경로가 아니므로 null.
 */
function readPathIn(
  text: string, start: number, end: number,
): { value: string; start: number; rawLength: number; quoted: boolean } | null {
  if (end <= start) return null;
  if (text[start] === "\"") {
    const read = readQuotedToken(text, start);
    if (!read || read.end > end) return null;
    return { value: read.value, start, rawLength: read.end - start, quoted: true };
  }
  const value = text.slice(start, end);
  return { value, start, rawLength: value.length, quoted: false };
}

/** 레코드에 경로 자리가 하나일 때(개행 모드가 아닌 모든 경우) 읽는다. */
function readPath(
  text: string, start: number,
): { value: string; start: number; rawLength: number; quoted: boolean } | null {
  return readPathIn(text, start, text.length);
}

/**
 * `git status --porcelain` 출력을 파싱한다.
 * 행 배열로 돌려줘야 근거 포인터(`/entries/0/path`)가 값 하나를 정확히 가리킨다.
 *
 * NUL 레코드 모드(-z)와 줄 레코드 모드는 레코드 경계·경로 표기·이름 변경 표기가 모두 다르다.
 * args 로 어느 모드인지 판별해 각자 다르게 읽는다.
 */
export function parseGitStatusPorcelain(
  args: string[], raw: string, ctx?: { maxItems?: number },
): { parsed: Omit<GitStatusPorcelain, never>; evidence: RawEvidence } {
  const nulRecords = usesNulRecords(args);
  const records: string[] = [];
  /** 각 레코드가 원문에서 시작한 문자 위치 */
  const starts: number[] = [];
  let at = 0;
  for (const record of raw.split(nulRecords ? "\0" : "\n")) {
    records.push(record);
    starts.push(at);
    at += record.length + 1;
  }
  /** 마지막 조각은 구분자 뒤의 빈 문자열이다 */
  if (records.length > 0 && records[records.length - 1] === "") records.pop();

  const entries: GitStatusEntry[] = [];
  const evidence: RawEvidence = {};
  let branch: string | undefined;
  let detached = false;

  for (let i = 0; i < records.length; i++) {
    const text = records[i]!;
    const base = starts[i]!;
    if (text === "") continue;

    if (text.startsWith("## ")) {
      const name = text.slice(3).trim();
      if (name === "HEAD (no branch)") { branch = "HEAD"; detached = true; }
      else if (name.startsWith("No commits yet on ")) branch = name.slice("No commits yet on ".length);
      else branch = name;
      continue;
    }

    const match = RECORD.exec(text);
    if (!match) continue;

    const index    = match[1]!;
    const worktree = match[2]!;
    const xy       = `${index}${worktree}`;
    const rest     = match[3]!;
    const restFrom = base + 3;

    /**
     * 줄 레코드 모드에서는 이름 변경이 `원래경로 -> 새경로` 한 줄로 온다.
     * 화살표는 오른쪽에서 찾아야 한다 — 경로 자체에 ' -> '가 들어갈 수 있기 때문이다.
     *   - 실측: 개행·탭 파일이 있는 저장소에서 `?? line -> x.txt` 도 그대로 나온다.
     */
    const isRename = index === "R" || index === "C" || worktree === "R" || worktree === "C";
    /** 원문에서 차지하는 위치와 길이. 경로가 이스케이프되었다면 값 길이와 rawLength 가 다르다. */
    let   orig: { value: string; from: number; rawLength: number; quoted: boolean } | undefined;
    let   next: { value: string; from: number; rawLength: number; quoted: boolean };

    if (isRename && !nulRecords) {
      const arrow = rest.lastIndexOf(" -> ");
      if (arrow === -1) continue;
      const left  = readPathIn(rest, 0, arrow);
      const right = readPath(rest, arrow + 4);
      if (!left || !right) continue;
      orig = { value: left.value,  from: restFrom + left.start,  rawLength: left.rawLength,  quoted: left.quoted };
      next = { value: right.value, from: restFrom + right.start, rawLength: right.rawLength, quoted: right.quoted };
    } else {
      const only = readPath(rest, 0);
      if (!only) continue;
      next = { value: only.value, from: restFrom + only.start, rawLength: only.rawLength, quoted: only.quoted };
      /** NUL 레코드 모드에서 이름 변경·복사면 다음 레코드가 원래 경로다 */
      if (isRename && i + 1 < records.length) {
        const record = records[i + 1]!;
        orig = { value: record, from: starts[i + 1]!, rawLength: record.length, quoted: false };
        i++;
      }
    }

    const row = entries.length;
    entries.push({
      xy, index, worktree, path: next.value,
      ...(orig !== undefined && { orig_path: orig.value }),
      ...((next.quoted || orig?.quoted === true) && { quoted: true }),
    });

    const recordNo = row + 1;
    const put = (pointer: string, s: RawSpan) => {
      const existing = evidence[pointer];
      if (existing) existing.push(s);
      else evidence[pointer] = [s];
    };
    put(`/entries/${row}/xy`,        span(recordNo, base, base + 2));
    put(`/entries/${row}/index`,     span(recordNo, base, base + 1));
    put(`/entries/${row}/worktree`,  span(recordNo, base + 1, base + 2));
    put(`/entries/${row}/path`,      span(recordNo, next.from, next.from + next.rawLength,
      next.quoted ? "unescape_c_quotes" : undefined));
    if (orig !== undefined) {
      put(`/entries/${row}/orig_path`, span(recordNo, orig.from, orig.from + orig.rawLength,
        orig.quoted ? "unescape_c_quotes" : undefined));
    }
  }

  const maxItems = ctx?.maxItems ?? 0;
  const total    = entries.length;
  const truncated = maxItems > 0 && total > maxItems;
  const parsed: GitStatusPorcelain = {
    entries: truncated ? entries.slice(0, maxItems) : entries,
    ...(branch !== undefined && { branch }),
    ...(detached && { detached: true as const }),
    ...(truncated && { _summary: { total, shown: maxItems, truncated: true } }),
  };
  return { parsed, evidence };
}

/** `--porcelain` 계열 인자를 썼는지 */
export function isPorcelainArgs(args: string[]): boolean {
  return args.some(a => a === "--porcelain" || a.startsWith("--porcelain="));
}
