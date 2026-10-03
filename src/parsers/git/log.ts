export interface GitCommit {
  hash:    string;
  message: string;
  /** --decorate로 표시된 참조(HEAD -> main, tag: v1.0, origin/main) */
  refs?:   string[];
  /** 작성자 이름(--format=%h%x09%an%x09%aI%x09%s) */
  author?: string;
  /** 작성 시각, ISO 8601(같은 형식) */
  date?:   string;
}

/** 해시, 작성자, 작성 시각, 제목을 탭으로 나눈 형식 */
const AUTHORED_FORMAT = /^(?:--format=|--pretty=format:)%[hH]%x09%an%x09%aI%x09%s$/;

/** 해시 다음의 "(HEAD -> refs/heads/main, tag: refs/tags/v1.0)" 꼬리표 */
const DECORATION = /^\(([^)]*)\)(?:\s+(.*))?$/;

/**
 * --decorate=full 참조 하나의 모양: HEAD, HEAD -> refs/heads/main, tag: refs/tags/v1.0, refs/remotes/origin/main, grafted.
 * 전체 이름은 refs/로 시작하므로 "(wip) 제목" 같은 괄호 제목과 가를 수 있다.
 */
const REF_ITEM = /^(?:HEAD(?: -> refs\/\S+)?|tag: refs\/\S+|refs\/\S+|grafted)$/;

/** 참조 꼬리표 하나를 항목으로 가른다. 참조 모양이 아니면 null. */
function splitRefs(text: string): string[] | null {
  const refs = text.split(", ");
  return refs.every(r => REF_ITEM.test(r)) ? refs : null;
}

/** 꼬리표 표시 여부. --decorate=full이 마지막 꼬리표 옵션일 때만 참이다(짧은 꼬리표는 계약이 받지 않는다). */
function fullDecoration(args: string[]): boolean {
  const last = args.filter(a => a === "--decorate" || a.startsWith("--decorate=") || a === "--no-decorate").pop();
  return last === "--decorate=full";
}

export function parseGitLog(cmd: string, args: string[], raw: string): { commits: GitCommit[] } {
  const commits: GitCommit[] = [];
  const decorated = fullDecoration(args);
  const authored  = args.some(a => AUTHORED_FORMAT.test(a));

  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    if (authored) {
      const cols = line.split("\t");
      if (cols.length >= 4 && /^[a-f0-9]+$/.test(cols[0]!)) {
        commits.push({ hash: cols[0]!, author: cols[1]!, date: cols[2]!, message: cols.slice(3).join("\t") });
      }
      continue;
    }
    const m = line.match(/^([a-f0-9]+)(?:\s+(.*))?$/);
    if (!m) continue;
    const hash = m[1]!;
    const rest = m[2] ?? "";

    const deco = decorated ? DECORATION.exec(rest) : null;
    const refs = deco ? splitRefs(deco[1]!) : null;
    if (deco && refs) commits.push({ hash, message: deco[2] ?? "", refs });
    else commits.push({ hash, message: rest });
  }

  return { commits };
}
