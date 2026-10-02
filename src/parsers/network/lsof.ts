import { UnrecognizedOutputError } from "../registry.js";

export interface LsofEntry {
  command:  string;
  pid:      number;
  user:     string;
  fd:       string;
  type:     string;
  device:   string;
  name:     string;
  state:    string | null;
}

/** 머리 줄의 열 이름과 위치 */
interface Column {
  name:  string;
  start: number;
  end:   number;
}

/** 이름 열 뒤의 TCP 상태: "(LISTEN)", "(ESTABLISHED)". 오류 안내 "(readlink: Permission denied)"는 상태가 아니다. */
const STATE_SUFFIX = /\s*\(([A-Z][A-Z0-9_]+)\)$/;

/** 머리 줄에서 열 이름과 시작, 끝 위치를 얻는다. */
function readHeader(header: string): Column[] {
  return [...header.matchAll(/\S+/g)].map(m => ({ name: m[0], start: m.index!, end: m.index! + m[0].length }));
}

/**
 * 줄의 값 조각마다 머리 열 가운데 가장 가까운 열에 배정한다.
 * lsof는 열 폭을 가장 긴 값에 맞춰 채우고 PID, FD, TYPE, DEVICE, SIZE/OFF, NODE는 오른쪽 맞춤,
 * COMMAND, USER, NAME은 왼쪽 맞춤이므로 조각의 중심이 속한 칸(머리 낱말 사이 간격의 중간선으로 나눈 칸)이 그 열이다.
 * 값이 없는 열(DEVICE 등)은 빈 문자열로 남는다. NAME은 칸 시작부터 줄 끝까지(공백 포함)다.
 */
function splitRow(line: string, columns: Column[]): Record<string, string> {
  const last   = columns.length - 1;
  const bounds = columns.slice(0, last).map((c, i) => (c.end + columns[i + 1]!.start) / 2);
  const nameAt = columns[last]!.start;
  const cells: Record<string, string> = Object.fromEntries(columns.map(c => [c.name, ""]));

  for (const m of line.slice(0, nameAt).matchAll(/\S+/g)) {
    const center = m.index! + m[0].length / 2;
    let i = bounds.findIndex(b => center < b);
    if (i < 0) i = last - 1;
    const column = columns[i]!.name;
    cells[column] = cells[column] ? `${cells[column]} ${m[0]}` : m[0];
  }
  cells[columns[last]!.name] = line.slice(nameAt).trim();
  return cells;
}

export function parseLsof(cmd: string, args: string[], raw: string): { entries: LsofEntry[] } {
  const lines = raw.split("\n").filter(Boolean);
  if (lines.length === 0) return { entries: [] };
  if (!/^COMMAND\s/.test(lines[0]!)) throw new UnrecognizedOutputError("lsof output has no COMMAND header line");

  const columns = readHeader(lines[0]!);
  const names   = new Set(columns.map(c => c.name));
  for (const required of ["COMMAND", "PID", "USER", "FD", "TYPE", "DEVICE", "NAME"]) {
    if (!names.has(required)) throw new UnrecognizedOutputError(`lsof header has no ${required} column`);
  }

  const entries: LsofEntry[] = [];
  for (const line of lines.slice(1)) {
    const cells = splitRow(line, columns);
    const pid   = parseInt(cells["PID"]!, 10);
    if (!Number.isFinite(pid)) continue;

    const state = STATE_SUFFIX.exec(cells["NAME"]!);
    entries.push({
      command: cells["COMMAND"]!,
      pid,
      user:    cells["USER"]!,
      fd:      cells["FD"]!,
      type:    cells["TYPE"]!,
      device:  cells["DEVICE"]!,
      name:    state ? cells["NAME"]!.replace(STATE_SUFFIX, "") : cells["NAME"]!,
      state:   state ? state[1]! : null,
    });
  }

  return { entries };
}
