export interface GitCommit {
  hash:    string;
  message: string;
  /** --decorate로 표시된 참조(HEAD -> main, tag: v1.0, origin/main) */
  refs?:   string[];
}

/** 해시 다음의 "(HEAD -> main, tag: v1.0)" 꼬리표 */
const DECORATION = /^\(([^)]*)\)(?:\s+(.*))?$/;

/** 참조 하나의 모양: HEAD, HEAD -> main, tag: v1.0, origin/main */
const REF_ITEM = /^(?:HEAD -> \S+|tag: \S+|\S+)$/;

/** 참조 꼬리표 하나를 항목으로 가른다. 참조 모양이 아니면 null. */
function splitRefs(text: string): string[] | null {
  const refs = text.split(", ");
  return refs.every(r => REF_ITEM.test(r)) ? refs : null;
}

export function parseGitLog(cmd: string, args: string[], raw: string): { commits: GitCommit[] } {
  const commits: GitCommit[] = [];
  const decorated = args.some(a => a === "--decorate" || /^--decorate=(short|full|auto)$/.test(a));

  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
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
