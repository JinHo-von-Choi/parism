import { readQuotedToken, unquoteGitPath } from "./paths.js";

export interface GitRename {
  old: string;
  new: string;
}

export interface GitStatus {
  branch:       string;
  staged:       string[];
  modified:     string[];
  untracked:    string[];
  /** 브랜치에 있지 않고 커밋에 체크아웃된 상태(detached HEAD)일 때 true */
  detached?:    true;
  /** detached HEAD가 가리키는 커밋 또는 이름 */
  detached_at?: string;
  /** 이름이 바뀐 항목(staged에는 새 경로가 들어 있다) */
  renamed?:     GitRename[];
  /** --ignored로 표시된 무시 대상 */
  ignored?:     string[];
  /** 병합 충돌 항목 */
  unmerged?:    string[];
}

type Section = "staged" | "modified" | "untracked" | "ignored" | "unmerged";

const SECTION_HEADERS: ReadonlyArray<readonly [RegExp, Section]> = [
  [/^Changes to be committed:/,       "staged"],
  [/^Changes not staged for commit:/, "modified"],
  [/^Unmerged paths:/,                "unmerged"],
  [/^Untracked files:/,               "untracked"],
  [/^Ignored files:/,                 "ignored"],
];

/** 하위 모듈 상태 꼬리표: "sub (new commits)", "sub (modified content, untracked content)" */
const SUBMODULE_NOTE = /\s+\((?:new commits|modified content|untracked content)(?:, (?:new commits|modified content|untracked content))*\)$/;

/** "old -> new" 또는 따옴표로 감싼 두 경로를 둘로 가른다. 가를 수 없으면 null. */
function splitRename(text: string): GitRename | null {
  const first = readQuotedToken(text, 0);
  if (first) {
    const arrow = text.slice(first.end, first.end + 4);
    if (arrow !== " -> ") return null;
    const rest   = text.slice(first.end + 4);
    const second = readQuotedToken(rest, 0);
    return { old: first.value, new: second && second.end === rest.length ? second.value : rest };
  }
  const at = text.indexOf(" -> ");
  if (at < 0) return null;
  return { old: text.slice(0, at), new: unquoteGitPath(text.slice(at + 4)) };
}

/** git status 기본(long) 형식 파싱 */
export function parseGitStatus(cmd: string, args: string[], raw: string): GitStatus {
  let branch                  = "unknown";
  let detached                = false;
  let detachedAt: string | undefined;

  const staged:    string[]    = [];
  const modified:  string[]    = [];
  const untracked: string[]    = [];
  const ignored:   string[]    = [];
  const unmerged:  string[]    = [];
  const renamed:   GitRename[] = [];

  let section: Section | null = null;

  for (const line of raw.split("\n")) {
    const onBranch = /^On branch (.+)$/.exec(line);
    if (onBranch) { branch = onBranch[1]!; continue; }
    const head = /^HEAD detached (?:at|from) (.+)$/.exec(line);
    if (head) { branch = "HEAD"; detached = true; detachedAt = head[1]!; continue; }
    if (/^Not currently on any branch\.?$/.test(line)) { branch = "HEAD"; detached = true; continue; }

    const header = SECTION_HEADERS.find(([pattern]) => pattern.test(line));
    if (header) { section = header[1]; continue; }
    if (line.startsWith("diff --git ")) { section = null; continue; }
    if (!section || !line.startsWith("\t")) continue;

    const body = line.slice(1);
    if (section === "untracked" || section === "ignored") {
      (section === "untracked" ? untracked : ignored).push(unquoteGitPath(body));
      continue;
    }

    const labelled = /^([a-z][a-z ]*?):\s+(.+)$/.exec(body);
    if (!labelled) continue;
    const label = labelled[1]!;
    const text  = labelled[2]!.replace(SUBMODULE_NOTE, "");

    if (section === "unmerged") { unmerged.push(unquoteGitPath(text)); continue; }

    const pair = label === "renamed" || label === "copied" ? splitRename(text) : null;
    const path = pair ? pair.new : unquoteGitPath(text);
    if (pair && label === "renamed") renamed.push(pair);
    (section === "staged" ? staged : modified).push(path);
  }

  return {
    branch, staged, modified, untracked,
    ...(detached && { detached: true as const }),
    ...(detachedAt && { detached_at: detachedAt }),
    ...(renamed.length > 0 && { renamed }),
    ...(ignored.length > 0 && { ignored }),
    ...(unmerged.length > 0 && { unmerged }),
  };
}
