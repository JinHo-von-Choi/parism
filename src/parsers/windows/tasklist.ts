export interface TasklistEntry {
  name:           string;
  pid:            number;
  session_name:   string;
  session_number: number;
  mem_usage_kb:   number;
}

export interface TasklistResult {
  processes: TasklistEntry[];
}

/**
 * Parses Windows `tasklist` command output.
 * Supports both default (table) and CSV (/fo csv) formats.
 */
export function parseTasklist(_cmd: string, _args: string[], raw: string): TasklistResult {
  const lines     = raw.split(/\r?\n/);
  const processes: TasklistEntry[] = [];

  // CSV format: "Image Name","PID","Session Name","Session#","Mem Usage"
  if (lines[0]?.startsWith('"')) {
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;
      // Split CSV, removing surrounding quotes
      const cols = line.split('","').map(c => c.replace(/^"|"$/g, ""));
      if (cols.length < 5) continue;
      processes.push({
        name:           cols[0],
        pid:            parseInt(cols[1], 10),
        session_name:   cols[2],
        session_number: parseInt(cols[3], 10),
        mem_usage_kb:   parseInt(cols[4].replace(/[^0-9]/g, ""), 10),
      });
    }
    return { processes };
  }

  // Default table format — fixed-width columns
  // "Image Name                     PID Session Name        Session#    Mem Usage"
  // "========================= ======== ================ =========== ============"
  // "System Idle Process              0 Services                   0         24 K"
  let headerParsed = false;
  let pidStart     = -1;
  let sessionStart = -1;
  let sessionNumStart = -1;
  let memStart     = -1;

  for (const line of lines) {
    if (!line.trim()) continue;

    // Separator line defines column widths
    if (line.match(/^[= ]+$/)) {
      const segs = line.split(/ (?=[^ ])/);
      let pos = 0;
      const widths: number[] = [];
      for (const seg of segs) {
        widths.push(seg.length);
        pos += seg.length + 1;
      }
      // columns: name(0), pid(1), session(2), session#(3), mem(4)
      if (widths.length >= 5) {
        pidStart        = widths[0] + 1;
        sessionStart    = pidStart + widths[1] + 1;
        sessionNumStart = sessionStart + widths[2] + 1;
        memStart        = sessionNumStart + widths[3] + 1;
        headerParsed    = true;
      }
      continue;
    }

    if (!headerParsed) continue;

    // Skip the header text line
    if (line.startsWith("Image Name")) continue;

    if (pidStart < 0 || line.length < pidStart) continue;

    const name          = line.slice(0, pidStart).trim();
    const pidStr        = line.slice(pidStart, sessionStart).trim();
    const sessionName   = line.slice(sessionStart, sessionNumStart).trim();
    const sessionNumStr = line.slice(sessionNumStart, memStart).trim();
    const memStr        = line.slice(memStart).trim();

    const pid = parseInt(pidStr, 10);
    if (isNaN(pid)) continue;

    processes.push({
      name,
      pid,
      session_name:   sessionName,
      session_number: parseInt(sessionNumStr, 10) || 0,
      mem_usage_kb:   parseInt(memStr.replace(/[^0-9]/g, ""), 10) || 0,
    });
  }

  return { processes };
}
