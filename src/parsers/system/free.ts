export interface FreeRow {
  total:           number;
  used:            number;
  free:            number;
  shared:          number | null;
  buff_cache:      number | null;
  available:       number | null;
  total_bytes:     number;
  used_bytes:      number;
  free_bytes:      number;
  shared_bytes:    number | null;
  buff_cache_bytes: number | null;
  available_bytes: number | null;
}

export interface FreeResult {
  mem:  FreeRow;
  swap: FreeRow | null;
  unit: string;
}

/**
 * "62Gi", "6.9Gi", "5.0M", "0B", "4096" 등을 bytes 정수로 변환한다.
 * 접미사에 i가 붙으면(Gi) 1024 단위, 붙지 않으면(--si의 G) 1000 단위이며 B는 바이트다.
 */
function parseSize(s: string): number {
  const m = s.match(/^([\d.]+)(?:([KMGTPE])(i?)|B)?$/i);
  if (!m) return NaN;
  const n = parseFloat(m[1]!);
  if (!m[2]) return Math.round(n);
  const power = "KMGTPE".indexOf(m[2].toUpperCase()) + 1;
  return Math.round(n * (m[3] ? 1024 : 1000) ** power);
}

/**
 * 플래그에 따라 숫자 한 단위가 몇 bytes인지 돌려준다. -h 는 값 자체가 접미사를 가지므로 1이다.
 * --si는 기본 단위(-k)와 -m, -g의 밑을 1000으로 바꾸고, --kilo/--mega/--giga는 1000 단위, --kibi/--mebi/--gibi는 1024 단위를 고른다.
 */
function unitFactor(args: string[]): { unit: string; factor: number } {
  const shorts = args.filter(a => /^-[A-Za-z]+$/.test(a)).map(a => a.slice(1)).join("");
  const has    = (...names: string[]): boolean => names.some(n => args.includes(n));
  const si     = has("--si");
  if (has("--human") || shorts.includes("h")) return { unit: "bytes", factor: 1 };
  if (has("--bytes") || shorts.includes("b")) return { unit: "bytes", factor: 1 };
  if (has("--giga")) return { unit: "giga", factor: 1000 ** 3 };
  if (has("--mega")) return { unit: "mega", factor: 1000 ** 2 };
  if (has("--kilo")) return { unit: "kilo", factor: 1000 };
  if (has("--gibi") || (!si && shorts.includes("g"))) return { unit: "GB", factor: 1024 ** 3 };
  if (has("--mebi") || (!si && shorts.includes("m"))) return { unit: "MB", factor: 1024 ** 2 };
  if (si && shorts.includes("g")) return { unit: "giga", factor: 1000 ** 3 };
  if (si && shorts.includes("m")) return { unit: "mega", factor: 1000 ** 2 };
  if (si) return { unit: "kilo", factor: 1000 };
  return { unit: "KB", factor: 1024 };
}

export function parseFree(cmd: string, args: string[], raw: string): FreeResult {
  const lines = raw.split("\n").filter(Boolean);
  const { unit, factor } = unitFactor(args);
  const human = args.includes("--human") || args.some(a => /^-[A-Za-z]*h[A-Za-z]*$/.test(a));

  const parseRow = (line: string): FreeRow => {
    const cols  = line.trim().split(/\s+/).slice(1).map(parseSize);
    const ok    = (i: number): boolean => cols[i] !== undefined && !isNaN(cols[i]!);
    const val   = (i: number): number => (ok(i) ? cols[i]! : 0);
    const opt   = (i: number): number | null => (ok(i) ? cols[i]! : null);
    const bytes = (n: number): number => (human ? n : Math.round(n * factor));
    const optB  = (i: number): number | null => (ok(i) ? bytes(cols[i]!) : null);
    return {
      total:            val(0),
      used:             val(1),
      free:             val(2),
      shared:           opt(3),
      buff_cache:       opt(4),
      available:        opt(5),
      total_bytes:      bytes(val(0)),
      used_bytes:       bytes(val(1)),
      free_bytes:       bytes(val(2)),
      shared_bytes:     optB(3),
      buff_cache_bytes: optB(4),
      available_bytes:  optB(5),
    };
  };

  const empty: FreeRow = {
    total: 0, used: 0, free: 0, shared: null, buff_cache: null, available: null,
    total_bytes: 0, used_bytes: 0, free_bytes: 0, shared_bytes: null, buff_cache_bytes: null, available_bytes: null,
  };

  const memLine  = lines.find(l => l.startsWith("Mem:"));
  const swapLine = lines.find(l => l.startsWith("Swap:"));

  return {
    mem:  memLine  ? parseRow(memLine)  : empty,
    swap: swapLine ? parseRow(swapLine) : null,
    unit,
  };
}
