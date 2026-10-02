import type { ParseContext } from "../registry.js";

export interface PsEntry {
  user:    string;
  pid:     number;
  cpu:     number;
  mem:     number;
  vsz:     number;
  rss:     number;
  tty:     string;
  stat:    string;
  start:   string;
  time:    string;
  command: string;
  /** --forest(f)로 출력한 트리에서 프로세스의 깊이. 루트는 0. */
  depth?:  number;
}

export interface PsSummary {
  total:     number;
  shown:     number;
  truncated: boolean;
}

/** BSD user 형식 데이터 줄: USER PID %CPU %MEM VSZ RSS TTY STAT START TIME COMMAND */
const ROW = /^(\S+)\s+(\d+)\s+(\d+(?:\.\d+)?)\s+(\d+(?:\.\d+)?)\s+(\d+)\s+(\d+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)(?: (.*))?$/;

/** 머리 줄(--headers는 화면 길이마다 되풀이한다) */
const HEADER = /^\s*USER\s+PID\s+%CPU\s+%MEM\s/;

/** 트리 출력의 COMMAND 열 앞 가지: 공백 하나 뒤에 깊이마다 4칸("|   " 또는 공백)이 오고 "\\_ "로 끝난다. TIME 값이 길어 열이 밀려도 TIME 뒤 구분 공백 하나로 COMMAND 열이 시작한다. */
const BRANCH = /^ ((?:\|\s{3}|\s{4})*)\\_ (.*)$/;

/** --forest 또는 BSD 옵션 글자 f가 있는지 */
function isForest(args: string[]): boolean {
  return args.includes("--forest") || args.some(a => !a.startsWith("-") && /^[A-Za-z]+$/.test(a) && a.includes("f"));
}

export function parsePs(
  cmd: string, args: string[], raw: string, ctx?: ParseContext,
): { processes: PsEntry[]; _summary?: PsSummary } {
  const forest    = isForest(args);
  const processes: PsEntry[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    if (HEADER.test(line)) continue;
    const m = ROW.exec(line.trimEnd());
    if (!m) continue;

    let command = (m[11] ?? "").trim();
    let depth: number | undefined;
    if (forest) {
      const branch = BRANCH.exec(m[11] ?? "");
      depth   = branch ? branch[1]!.length / 4 + 1 : 0;
      command = branch ? branch[2]!.trim() : command;
    }

    processes.push({
      user:    m[1]!,
      pid:     parseInt(m[2]!, 10),
      cpu:     parseFloat(m[3]!),
      mem:     parseFloat(m[4]!),
      vsz:     parseInt(m[5]!, 10),
      rss:     parseInt(m[6]!, 10),
      tty:     m[7]!,
      stat:    m[8]!,
      start:   m[9]!,
      time:    m[10]!,
      command,
      ...(depth !== undefined && { depth }),
    });
  }

  const maxItems = ctx?.maxItems ?? 0;
  if (maxItems > 0 && processes.length > maxItems) {
    return {
      processes: processes.slice(0, maxItems),
      _summary:  { total: processes.length, shown: maxItems, truncated: true },
    };
  }
  return { processes };
}
