import type { ParseContext }    from "../registry.js";
import type { RawEvidence, RawSpan } from "../../engine/evidence.js";

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

/**
 * BSD user 형식 데이터 줄: USER PID %CPU %MEM VSZ RSS TTY STAT START TIME COMMAND
 * d 플래그로 캡처 그룹의 문자열 위치를 얻는다(근거 계산에 쓴다).
 */
const ROW = /^(\S+)\s+(\d+)\s+(\d+(?:\.\d+)?)\s+(\d+(?:\.\d+)?)\s+(\d+)\s+(\d+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)(?: (.*))?$/d;

/** 캡처 그룹 순서와 필드 이름 */
const ROW_FIELDS = ["user", "pid", "cpu", "mem", "vsz", "rss", "tty", "stat", "start", "time"] as const;

/** 숫자 필드로 바꾼 그룹. 원문은 문자열이고 값은 숫자라 변환이 있었다고 밝힌다. */
const NUMERIC_FIELDS: Record<string, string> = { pid: "parseInt", cpu: "parseFloat", mem: "parseFloat", vsz: "parseInt", rss: "parseInt" };

/** 머리 줄(--headers는 화면 길이마다 되풀이한다) */
const HEADER = /^\s*USER\s+PID\s+%CPU\s+%MEM\s/;

/** 트리 출력의 COMMAND 열 앞 가지: 공백 하나 뒤에 깊이마다 4칸("|   " 또는 공백)이 오고 "\_ "로 끝난다. TIME 값이 길어 열이 밀려도 TIME 뒤 구분 공백 하나로 COMMAND 열이 시작한다. */
const BRANCH = /^ ((?:\|\s{3}|\s{4})*)\\_ (.*)$/d;

/** --forest 또는 BSD 옵션 글자 f가 있는지 */
function isForest(args: string[]): boolean {
  return args.includes("--forest") || args.some(a => !a.startsWith("-") && /^[A-Za-z]+$/.test(a) && a.includes("f"));
}


interface ParsedLine {
  entry:  PsEntry;
  spans:  { field: string; start: number; end: number; transform?: string }[];
}

/** 한 줄에서 항목과 필드별 문자열 위치를 읽는다. 줄 안에서의 오프셋을 돌려준다. */
function readLine(line: string, forest: boolean): ParsedLine | null {
  /**
   * 줄을 다듬지 않고 원문 그대로 매칭한다. 다듬으면 문자열 위치가 원문과 어긋나 근거가 어긋난다.
   * 뒤 공백은 11번 그룹에 들어오고 명령 문자열을 만들 때 스스로 다듬는다.
   */
  const m = ROW.exec(line);
  if (!m) return null;
  const indices = m.indices;
  if (!indices) return null;

  const spans: ParsedLine["spans"] = [];
  ROW_FIELDS.forEach((field, i) => {
    const range = indices[i + 1];
    if (!range) return;
    spans.push({ field, start: range[0], end: range[1], ...(NUMERIC_FIELDS[field] && { transform: NUMERIC_FIELDS[field] }) });
  });

  const tailRange = indices[11];
  const tail      = m[11] ?? "";
  let command    = tail.trim();
  let depth: number | undefined;
  let commandStart: number | undefined;
  let commandEnd:   number | undefined;
  let commandTransform: string | undefined;

  if (forest) {
    const branch = BRANCH.exec(tail);
    depth   = branch ? branch[1]!.length / 4 + 1 : 0;
    command = branch ? branch[2]!.trim() : command;
  }
  if (tailRange) {
    const offset = tailRange[0];
    const inner  = BRANCH.exec(tail);
    if (forest && inner) {
      /** 트리 접두사("|   \_ ")는 값을 만들지 않았으므로 가리킨다. 남은 부분만 명령 문자열이다. */
      const range2 = inner.indices?.[2];
      if (range2) {
        commandStart = offset + range2[0];
        commandEnd   = offset + range2[1];
      }
      commandTransform = "strip_tree_prefix";
    } else {
      const lead = tail.length - tail.trimStart().length;
      const trim = tail.trim().length;
      commandStart = offset + lead;
      commandEnd   = offset + lead + trim;
      commandTransform = command.length === 0 ? "empty" : "trim";
    }
    if (commandStart !== undefined && commandEnd !== undefined) {
      spans.push({ field: "command", start: commandStart, end: commandEnd, transform: commandTransform });
    }
  }

  return {
    entry: {
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
    },
    spans,
  };
}

export function parsePs(
  cmd: string, args: string[], raw: string, ctx?: ParseContext,
): { processes: PsEntry[]; _summary?: PsSummary } {
  return rowsOnly(parsePsRows(args, raw, ctx));
}

/**
 * 항목과 함께 필드별 원문 위치를 함께 돌려준다.
 * 근거가 없는 계약 밖 형식에서는 근거 표를 비운다(레거시 경로에 근거를 지어내지 않는다).
 */
export function parsePsWithEvidence(
  cmd: string, args: string[], raw: string, ctx?: ParseContext,
): { processes: PsEntry[]; _summary?: PsSummary; evidence: RawEvidence } {
  const rows = parsePsRows(args, raw, ctx);
  const { processes, lines } = rows;
  const evidence: RawEvidence = {};

  processes.forEach((_, index) => {
    const row = lines[index];
    if (!row) return;
    for (const span of row.spans) {
      const pointer = `/processes/${index}/${span.field}`;
      const rawSpan: RawSpan = {
        source: "stdout", line: row.line, start: span.start, end: span.end,
        ...(span.transform && { transform: span.transform }),
      };
      const existing = evidence[pointer];
      if (existing) existing.push(rawSpan);
      else evidence[pointer] = [rawSpan];
    }
  });
  return { ...rowsOnly(rows), evidence };
}

/** 절단됐을 때만 절단 요약을 붙인다. */
function rowsOnly(
  rows: ParsedRows,
): { processes: PsEntry[]; _summary?: PsSummary } {
  return rows.processes.length > 0 && rows.truncated
    ? { processes: rows.processes, _summary: { total: rows.total, shown: rows.processes.length, truncated: true } }
    : { processes: rows.processes };
}

/** 파싱된 항목과 각 항목이 나온 줄 번호를 함께 돌려준다. */
interface ParsedRows {
  processes: PsEntry[];
  lines:     ({ line: number; spans: ParsedLine["spans"] } | undefined)[];
  total:     number;
  truncated: boolean;
}

function parsePsRows(args: string[], raw: string, ctx?: ParseContext): ParsedRows {
  const forest    = isForest(args);
  const processes: PsEntry[] = [];
  const lines: ({ line: number; spans: ParsedLine["spans"] } | undefined)[] = [];
  const rawLines  = raw.split("\n");

  rawLines.forEach((line, index) => {
    if (!line.trim() || HEADER.test(line)) return;
    const parsed = readLine(line, forest);
    if (!parsed) return;
    processes.push(parsed.entry);
    lines.push({ line: index + 1, spans: parsed.spans });
  });

  const total     = processes.length;
  const maxItems  = ctx?.maxItems ?? 0;
  const truncated = maxItems > 0 && total > maxItems;
  return {
    processes: truncated ? processes.slice(0, maxItems) : processes,
    lines:     truncated ? lines.slice(0, maxItems) : lines,
    total,
    truncated,
  };
}
