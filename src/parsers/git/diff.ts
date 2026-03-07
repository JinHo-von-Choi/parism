const MAX_HUNKS_PER_FILE = 50;
const MAX_HUNK_LINES     = 5000;

export interface DiffHunk {
  start_a: number;
  count_a: number;
  start_b: number;
  count_b: number;
  lines:   string[];
}

export interface DiffFile {
  path:  string;
  hunks: DiffHunk[];
}

export interface GitDiffResult {
  raw:          string;
  files_changed: string[];
  files?:       DiffFile[];
  _truncated?:  boolean;
  _summary?:    string;
}

/**
 * git diff 표준 형식 파싱.
 * files_changed: 변경된 파일 경로 목록.
 * files: 파일별 hunk 상세 (추가/삭제 라인 포함).
 * truncation: 파일당 최대 50 hunk, 전체 5000 라인 초과 시 _truncated.
 */
export function parseGitDiff(cmd: string, args: string[], raw: string): GitDiffResult {
  const filesChanged = raw.match(/^---\s+a\/(.+)$/gm)?.map((l) => l.replace(/^---\s+a\//, "")) ?? [];
  const files: DiffFile[] = [];
  let totalLines = 0;
  let truncated  = false;

  const diffBlocks = raw.split(/(?=^diff --git )/m).filter(Boolean);

  for (const block of diffBlocks) {
    if (!block.startsWith("diff --git ")) continue;

    const pathMatch = block.match(/^diff --git a\/(.+?) b\//m);
    if (!pathMatch) continue;

    const path = pathMatch[1]!.trim();
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

    files.push({ path, hunks });
  }

  return {
    raw,
    files_changed: filesChanged,
    files,
    ...(truncated && {
      _truncated: true,
      _summary:    "too large to parse",
    }),
  };
}
