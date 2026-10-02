export interface DfEntry {
  filesystem:  string;
  /** -T로 표시한 파일 시스템 종류 */
  type?:       string;
  /** 1K 블록 수, 또는 -h/-H의 단위 붙은 크기("547G") */
  blocks_1k?:  string;
  /** 1K가 아닌 블록 단위(-m, -B1M)의 크기. 단위는 결과의 block_size다. */
  size?:       string;
  used:        string;
  available:   string;
  use_percent: string;
  mounted_on:  string;
}

export interface DfResult {
  filesystems: DfEntry[];
  /** 크기 열의 블록 단위(예: "1M"). 1K 블록이나 단위 붙은 크기(-h)이면 없다. */
  block_size?: string;
}

/** 숫자 열 모양: 블록 수, 단위 붙은 크기("1.5G", "88K"), 값 없음("-") */
const AMOUNT  = /^(?:\d+(?:\.\d+)?[KkMGTPEZY]?i?B?|-)$/;
const PERCENT = /^(?:\d+%|-)$/;

/** 머리 줄에서 Type 열과 크기 열 이름을 읽는다. */
function readHeader(header: string): { typed: boolean; sizeColumn: string } {
  const words = header.trim().split(/\s+/);
  const typed = words[1] === "Type";
  return { typed, sizeColumn: words[typed ? 2 : 1] ?? "" };
}

/** 크기 열 이름을 블록 단위로 바꾼다: "1K-blocks"는 1K, "Size"는 단위가 값에 붙은 형식, 그 밖에는 "1M" 같은 단위. */
function blockUnit(sizeColumn: string): "1K" | "human" | string {
  const m = /^(\d+[KMGTPEZY]?)-blocks$/i.exec(sizeColumn);
  if (!m) return "human";
  return m[1] === "1024" || m[1]!.toUpperCase() === "1K" ? "1K" : m[1]!;
}

/**
 * 데이터 줄을 오른쪽 숫자 열 기준으로 가른다. 파일 시스템 이름과 마운트 위치에는 공백이 들어갈 수 있으므로
 * 크기, 사용, 가용, 사용률이 연달아 나오는 위치를 찾아 그 앞을 이름(과 종류), 뒤를 마운트 위치로 본다.
 */
function splitRow(tokens: string[], typed: boolean): { fs: string[]; type: string | undefined; nums: string[]; mount: string } | null {
  const lead = typed ? 2 : 1;
  for (let i = lead + 3; i < tokens.length; i++) {
    if (!PERCENT.test(tokens[i]!)) continue;
    if (!AMOUNT.test(tokens[i - 1]!) || !AMOUNT.test(tokens[i - 2]!) || !AMOUNT.test(tokens[i - 3]!)) continue;
    const head = tokens.slice(0, i - 3);
    const type = typed ? head[head.length - 1] : undefined;
    return { fs: typed ? head.slice(0, -1) : head, type, nums: [tokens[i - 3]!, tokens[i - 2]!, tokens[i - 1]!, tokens[i]!], mount: tokens.slice(i + 1).join(" ") };
  }
  return null;
}

export function parseDf(cmd: string, args: string[], raw: string): DfResult {
  const lines       = raw.split("\n").filter(Boolean);
  const filesystems: DfEntry[] = [];
  const { typed, sizeColumn } = readHeader(lines[0] ?? "");
  const unit  = blockUnit(sizeColumn);
  const fixed = unit !== "1K" && unit !== "human";

  for (const line of lines.slice(1)) {
    const row = splitRow(line.trim().split(/\s+/), typed);
    if (!row) continue;
    const [amount, used, available, percent] = row.nums as [string, string, string, string];
    filesystems.push({
      filesystem:  row.fs.join(" "),
      ...(row.type !== undefined && { type: row.type }),
      ...(fixed ? { size: amount } : { blocks_1k: amount }),
      used,
      available,
      use_percent: percent,
      mounted_on:  row.mount,
    });
  }

  return { filesystems, ...(fixed && { block_size: unit }) };
}
