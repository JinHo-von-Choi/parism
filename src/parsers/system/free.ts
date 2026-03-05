export interface FreeRow {
  total:      number;
  used:       number;
  free:       number;
  shared:     number | null;
  buff_cache: number | null;
  available:  number | null;
}

export interface FreeResult {
  mem:  FreeRow;
  swap: FreeRow | null;
  unit: string;
}

/** "62Gi", "6.9Gi", "5.0M", "4096" 등을 bytes 정수로 변환 */
function parseSize(s: string): number {
  const m = s.match(/^([\d.]+)([KMGTPE]i?)?$/i);
  if (!m) return NaN;
  const n   = parseFloat(m[1]);
  const sfx = (m[2] ?? "").toUpperCase().replace("I", "");
  const mul: Record<string, number> = {
    "":  1,
    "K": 1024,
    "M": 1024 ** 2,
    "G": 1024 ** 3,
    "T": 1024 ** 4,
    "P": 1024 ** 5,
  };
  return Math.round(n * (mul[sfx] ?? 1));
}

export function parseFree(cmd: string, args: string[], raw: string): FreeResult {
  const lines = raw.split("\n").filter(Boolean);

  const parseRow = (line: string): FreeRow => {
    const cols = line.trim().split(/\s+/).slice(1).map(parseSize);
    return {
      total:      isNaN(cols[0]) ? 0    : cols[0],
      used:       isNaN(cols[1]) ? 0    : cols[1],
      free:       isNaN(cols[2]) ? 0    : cols[2],
      shared:     cols[3] !== undefined && !isNaN(cols[3]) ? cols[3] : null,
      buff_cache: cols[4] !== undefined && !isNaN(cols[4]) ? cols[4] : null,
      available:  cols[5] !== undefined && !isNaN(cols[5]) ? cols[5] : null,
    };
  };

  const memLine  = lines.find(l => l.startsWith("Mem:"));
  const swapLine = lines.find(l => l.startsWith("Swap:"));

  // 단위 감지: args에 -m, -g, -k 등
  const unit = args.includes("-g") ? "GB"
             : args.includes("-m") ? "MB"
             : args.includes("-k") ? "KB"
             : "bytes";

  return {
    mem:  memLine  ? parseRow(memLine)  : { total: 0, used: 0, free: 0, shared: null, buff_cache: null, available: null },
    swap: swapLine ? parseRow(swapLine) : null,
    unit,
  };
}
