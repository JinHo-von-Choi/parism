import { readQuotedToken, unquoteGitPath } from "./paths.js";

const MAX_HUNKS_PER_FILE = 50;
const MAX_HUNK_LINES     = 5000;

export interface DiffHunk {
  start_a: number;
  count_a: number;
  start_b: number;
  count_b: number;
  lines:   string[];
}

/** 파일 변경 종류 */
export type DiffFileStatus = "modified" | "added" | "deleted" | "renamed" | "copied";

export interface DiffFile {
  path:      string;
  hunks:     DiffHunk[];
  /** 변경 종류. 모드만 바뀐 파일은 modified이다. */
  status?:   DiffFileStatus;
  /** 이름 바꾸기와 복사에서 원래 경로 */
  old_path?: string;
  /** 바이너리 변경이면 true */
  binary?:   true;
}

export interface GitDiffResult {
  raw:          string;
  files_changed: string[];
  files?:       DiffFile[];
  _truncated?:  boolean;
  _summary?:    string;
}

/** 머리 줄 한 개의 접두를 떼고 따옴표와 끝 탭을 풀어 경로를 얻는다. /dev/null은 null. */
function headerPath(text: string, prefix: string): string | null {
  const value = unquoteGitPath(text.replace(/\t$/, ""));
  if (value === "/dev/null") return null;
  return prefix && value.startsWith(prefix) ? value.slice(prefix.length) : value;
}

/**
 * "diff --git a/X b/Y" 줄에서 두 경로를 얻는다. 파일 이름에 공백이 있으면 모호하므로
 * 따옴표 형식, 또는 앞뒤 경로가 같은 경우(길이로 가를 수 있음)만 해석하고 나머지는 null이다.
 */
function pathsFromDiffLine(line: string, prefixes: readonly [string, string]): [string, string] | null {
  const text = line.slice("diff --git ".length);
  const [pa, pb] = prefixes;
  const first = readQuotedToken(text, 0);
  if (first) {
    const second = readQuotedToken(text, first.end + 1);
    if (!second || text[first.end] !== " " || second.end !== text.length) return null;
    return [stripPrefix(first.value, pa), stripPrefix(second.value, pb)];
  }
  const total = text.length - (pa.length + pb.length + 1);
  if (total < 0 || total % 2 !== 0) return null;
  const half = total / 2;
  const a    = text.slice(pa.length, pa.length + half);
  if (text !== `${pa}${a} ${pb}${a}`) return null;
  return [a, a];
}

function stripPrefix(value: string, prefix: string): string {
  return prefix && value.startsWith(prefix) ? value.slice(prefix.length) : value;
}

/** diff 한 파일 구간의 머리 줄(첫 @@ 앞)에서 경로와 변경 종류를 읽는다. */
function parseFileHeader(block: string, prefixes: readonly [string, string]): Omit<DiffFile, "hunks"> | null {
  const headerEnd = block.search(/^@@ /m);
  const lines     = (headerEnd >= 0 ? block.slice(0, headerEnd) : block).split("\n");

  let oldPath: string | null | undefined;
  let newPath: string | null | undefined;
  let renameFrom: string | undefined;
  let renameTo:   string | undefined;
  let copyFrom:   string | undefined;
  let copyTo:     string | undefined;
  let status: DiffFileStatus = "modified";
  let binary = false;

  for (const line of lines.slice(1)) {
    if (line.startsWith("new file mode "))          status = "added";
    else if (line.startsWith("deleted file mode ")) status = "deleted";
    else if (line.startsWith("rename from "))       renameFrom = unquoteGitPath(line.slice(12));
    else if (line.startsWith("rename to "))         renameTo   = unquoteGitPath(line.slice(10));
    else if (line.startsWith("copy from "))         copyFrom   = unquoteGitPath(line.slice(10));
    else if (line.startsWith("copy to "))           copyTo     = unquoteGitPath(line.slice(8));
    else if (line.startsWith("--- "))               oldPath    = headerPath(line.slice(4), prefixes[0]);
    else if (line.startsWith("+++ "))               newPath    = headerPath(line.slice(4), prefixes[1]);
    else if (line.startsWith("Binary files ") || line === "GIT binary patch") binary = true;
  }

  const base = (path: string): Omit<DiffFile, "hunks"> => ({ path, status, ...(binary && { binary: true as const }) });
  if (renameTo !== undefined) return { ...base(renameTo), status: "renamed", ...(renameFrom !== undefined && { old_path: renameFrom }) };
  if (copyTo !== undefined)   return { ...base(copyTo),   status: "copied",  ...(copyFrom !== undefined && { old_path: copyFrom }) };
  if (newPath)                return base(newPath);
  if (oldPath)                return base(oldPath);

  const fromLine = pathsFromDiffLine(lines[0]!, prefixes);
  if (fromLine) return base(status === "deleted" ? fromLine[0] : fromLine[1]);
  return null;
}

/**
 * git diff 표준 형식 파싱.
 * files_changed: 변경된 파일 경로 목록(이름을 바꾼 파일은 새 경로).
 * files: 파일별 변경 종류와 hunk 상세 (추가/삭제 라인 포함).
 * truncation: 파일당 최대 50 hunk, 전체 5000 라인 초과 시 _truncated.
 */
export function parseGitDiff(cmd: string, args: string[], raw: string): GitDiffResult {
  const prefixes: readonly [string, string] = args.includes("--no-prefix") ? ["", ""] : ["a/", "b/"];
  const files: DiffFile[] = [];
  let totalLines = 0;
  let truncated  = false;

  const diffBlocks = raw.split(/(?=^diff --git )/m).filter(Boolean);

  for (const block of diffBlocks) {
    if (!block.startsWith("diff --git ")) continue;

    const header = parseFileHeader(block, prefixes);
    if (!header) continue;

    const hunks: DiffHunk[] = [];
    let fileLines = 0;

    const hunkRegex = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/gm;
    let hunkMatch;

    while ((hunkMatch = hunkRegex.exec(block)) !== null) {
      if (hunks.length >= MAX_HUNKS_PER_FILE || totalLines >= MAX_HUNK_LINES) {
        truncated = true;
        break;
      }

      const startA = parseInt(hunkMatch[1]!, 10);
      const countA = parseInt(hunkMatch[2] ?? "1", 10);
      const startB = parseInt(hunkMatch[3]!, 10);
      const countB = parseInt(hunkMatch[4] ?? "1", 10);

      const hunkStart = hunkMatch.index;
      const nextHunk = block.slice(hunkStart).indexOf("\n@@ ");
      const hunkEnd =
        nextHunk >= 0 ? hunkStart + nextHunk : block.length;
      const hunkBody = block.slice(hunkStart, hunkEnd);

      const lines = hunkBody.split("\n").slice(1);

      if (fileLines + lines.length > MAX_HUNK_LINES - totalLines) {
        truncated = true;
        break;
      }

      hunks.push({ start_a: startA, count_a: countA, start_b: startB, count_b: countB, lines });
      fileLines += lines.length;
      totalLines += lines.length;
    }

    files.push({ ...header, hunks });
  }

  return {
    raw,
    files_changed: files.map(f => f.path),
    files,
    ...(truncated && {
      _truncated: true,
      _summary:    "too large to parse",
    }),
  };
}
