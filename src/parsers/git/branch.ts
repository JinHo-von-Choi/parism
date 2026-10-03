export interface GitBranchEntry {
  current:   boolean;
  name:      string;
  hash:      string;
  upstream:  string | null;
  /** 상류보다 앞선 커밋 수. 상류가 사라졌으면(gone) 알 수 없어 null이다. */
  ahead:     number | null;
  /** 상류보다 뒤진 커밋 수. 상류가 사라졌으면(gone) 알 수 없어 null이다. */
  behind:    number | null;
  message:   string;
  /** 추적하던 상류 브랜치가 원격에서 사라졌으면(git이 [gone]으로 표시) true */
  upstream_gone?: true;
  /** 다른 작업 트리에서 체크아웃된 브랜치(+ 표시)일 때 true */
  worktree?: true;
  /** 심볼릭 참조(origin/HEAD -> origin/main)가 가리키는 대상 */
  points_to?: string;
  /** detached HEAD 항목이면 true */
  detached?: true;
}

/** "(HEAD detached at abc1234)" 또는 "(no branch)" 같은 괄호 이름 */
const DETACHED_NAME = /^\((?:HEAD detached (?:at|from) [^)]*|no branch[^)]*)\)/;

/**
 * 해시 다음 부분: 해시, 다른 작업 트리 경로(-vv), 추적 정보 대괄호, 제목.
 * 대괄호는 추적 정보 모양일 때만 추적 정보로 읽고, 아니면 제목의 일부다.
 */
const TAIL = /^([a-f0-9]+)(?:\s+\((?:\/|[A-Za-z]:)[^)]*\))?(?:\s+\[([^\]]+)\])?(?:\s+(.*))?$/;

/** 추적 정보 모양(-vv): "ahead 1", "gone", "origin/main", "origin/main: ahead 1, behind 2" */
const TRACKING    = /^(?:(?:ahead \d+|behind \d+|gone)(?:, (?:ahead \d+|behind \d+))?|[^\s:[\]]+(?:: (?:ahead \d+|behind \d+|gone)(?:, (?:ahead \d+|behind \d+))?)?)$/;
/** 상류 이름 없이 상태만 있는 추적 정보(-v) */
const STATUS_ONLY = /^(?:ahead \d+|behind \d+|gone)(?:, (?:ahead \d+|behind \d+))?$/;

/** 줄 앞 표시(현재 `*`, 다른 작업 트리 `+`)와 나머지를 가른다. */
function splitMarker(line: string): { marker: string; rest: string } | null {
  const m = /^([*+ ]) (.*)$/.exec(line);
  return m ? { marker: m[1]!, rest: m[2]! } : null;
}

export function parseGitBranch(cmd: string, args: string[], raw: string): { branches: GitBranchEntry[] } {
  const branches: GitBranchEntry[] = [];
  /** -vv(상류 이름까지 표시)일 때만 상류 이름 모양의 대괄호를 추적 정보로 읽는다. */
  const verbose = args.reduce((n, a) => n + (a === "--verbose" ? 1 : /^-[A-Za-z]+$/.test(a) ? [...a].filter(c => c === "v").length : 0), 0);

  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;

    const split = splitMarker(line);
    if (!split) continue;
    const { marker, rest } = split;
    const current = marker === "*";

    const detached = DETACHED_NAME.exec(rest);
    let name:      string;
    let pointsTo:  string | undefined;
    let tail:      string;

    if (detached) {
      name = detached[0];
      tail = rest.slice(name.length).trimStart();
    } else {
      /** -v에서는 이름 열을 맞추느라 "->" 앞에 공백이 여럿 온다. 해시는 "->"로 시작할 수 없으므로 모호하지 않다. */
      const alias = /^(\S+)\s+->\s+(\S+)(?:\s+(.*))?$/.exec(rest);
      if (alias) {
        name     = alias[1]!;
        pointsTo = alias[2];
        tail     = alias[3] ?? "";
      } else {
        const sp = /^(\S+)\s+(.*)$/.exec(rest);
        if (!sp) continue;
        name = sp[1]!;
        tail = sp[2]!;
      }
    }

    if (pointsTo !== undefined && tail === "") {
      branches.push({ current, name, hash: "", upstream: null, ahead: 0, behind: 0, message: "", points_to: pointsTo });
      continue;
    }

    const m = TAIL.exec(tail);
    if (!m) continue;

    const [, hash, trackRaw, subject = ""] = m;
    const track    = trackRaw !== undefined && (verbose >= 2 ? TRACKING : STATUS_ONLY).test(trackRaw) ? trackRaw : null;
    const upstream = track !== null && !STATUS_ONLY.test(track) ? track.split(":")[0]!.trim() : null;
    const status   = track !== null ? track.slice(track.indexOf(":") + 1) : "";

    const gone   = status.trim() === "gone";
    const ahead  = /ahead (\d+)/.exec(status);
    const behind = /behind (\d+)/.exec(status);

    branches.push({
      current, name, hash: hash!, upstream,
      ahead:   gone ? null : ahead ? parseInt(ahead[1]!, 10) : 0,
      behind:  gone ? null : behind ? parseInt(behind[1]!, 10) : 0,
      message: track === null && trackRaw !== undefined ? `[${trackRaw}] ${subject}`.trimEnd() : subject,
      ...(gone && { upstream_gone: true as const }),
      ...(marker === "+" && { worktree: true as const }),
      ...(pointsTo !== undefined && { points_to: pointsTo }),
      ...(detached && { detached: true as const }),
    });
  }

  return { branches };
}
