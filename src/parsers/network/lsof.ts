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

export function parseLsof(cmd: string, args: string[], raw: string): { entries: LsofEntry[] } {
  const lines   = raw.split("\n").filter(Boolean);
  const entries: LsofEntry[] = [];

  for (const line of lines.slice(1)) { // 헤더 제외
    const cols = line.trim().split(/\s+/);
    if (cols.length < 9) continue;

    // NAME 컬럼은 마지막, STATE는 괄호 안에 있을 수 있음
    const namePart   = cols.slice(8).join(" ");
    const stateMatch = namePart.match(/\(([^)]+)\)$/);
    const state      = stateMatch ? stateMatch[1] : null;
    const name       = stateMatch ? namePart.replace(/\s*\([^)]+\)$/, "").trim() : namePart.trim();

    entries.push({
      command: cols[0],
      pid:     parseInt(cols[1], 10),
      user:    cols[2],
      fd:      cols[3],
      type:    cols[4],
      device:  cols[5],
      name,
      state,
    });
  }

  return { entries };
}
