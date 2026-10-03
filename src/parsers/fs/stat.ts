export interface StatResult {
  file:        string;
  size_bytes:  number;
  blocks:      number;
  io_block:    number;
  file_type:   string;
  inode:       number;
  links:       number;
  permissions: string;
  uid:         number;
  uid_name:    string;
  gid:         number;
  gid_name:    string;
  accessed_at: string;
  modified_at: string;
  changed_at:  string;
  birth_at:    string;
  /** 심볼릭 링크가 가리키는 경로(File: 줄의 "이름 -> 대상") */
  link_target?: string;
}

/** 파일 여러 개를 준 stat 결과 */
export interface StatMany {
  files: StatResult[];
}

/**
 * macOS/BSD stat 단일 줄 형식 파싱.
 * 형식: dev ino mode nlink uid gid rdev size "atime" "mtime" "ctime" "btime" blksize blocks flags path
 */
function parseStatMacos(raw: string): StatResult | null {
  const line = raw.trim();
  if (!line || line.includes("File:")) return null;

  const match = line.match(
    /^\d+\s+\d+\s+(\S+)\s+\d+\s+\S+\s+\S+\s+\d+\s+(\d+)\s+"([^"]*)"\s+"([^"]*)"\s+"([^"]*)"\s+"([^"]*)"\s+\d+\s+\d+\s+\S+\s+(.+)$/,
  );
  if (!match) return null;

  const named = splitFileLine(match[7]!.trim());
  return {
    file:        named.file,
    size_bytes:  parseInt(match[2]!, 10),
    blocks:      0,
    io_block:    0,
    file_type:   "",
    inode:       0,
    links:       0,
    permissions: match[1]!,
    uid:         0,
    uid_name:    "",
    gid:         0,
    gid_name:    "",
    accessed_at: "",
    modified_at: match[4]!,
    changed_at:  match[5]!,
    birth_at:    match[6]!,
    ...(named.link_target !== undefined && { link_target: named.link_target }),
  };
}

/** File: 줄에서 이름과 링크 대상을 가른다. */
function splitFileLine(text: string): { file: string; link_target?: string } {
  const at = text.indexOf(" -> ");
  return at < 0 ? { file: text } : { file: text.slice(0, at), link_target: text.slice(at + 4) };
}

/** GNU stat 한 파일 구간(File: 줄부터 Birth: 줄까지) 파싱 */
function parseStatBlock(raw: string): StatResult | null {
  /** "File: " 다음 한 칸 뒤부터 줄 끝까지가 이름이다. 이름 앞뒤의 공백도 이름의 일부다. */
  const fileMatch    = raw.match(/^\s*File: (.+)$/m);
  const sizeMatch    = raw.match(/\s*Size:\s*(\d+)/);
  const blocksMatch  = raw.match(/Blocks:\s*(\d+)/);
  const ioBlockMatch = raw.match(/IO Block:\s*(\d+)/);
  const fileTypeMatch = raw.match(/IO Block:\s*\d+\s+(.+)/);
  const inodeMatch   = raw.match(/Inode:\s*(\d+)/);
  const linksMatch   = raw.match(/Links:\s*(\d+)/);
  const permMatch    = raw.match(/Access:\s*\(\d+\/([^)]+)\)/);
  const uidMatch     = raw.match(/Uid:\s*\(\s*(\d+)\/\s*([^)]+)\)/);
  const gidMatch     = raw.match(/Gid:\s*\(\s*(\d+)\/\s*([^)]+)\)/);

  if (!fileMatch || !sizeMatch) return null;

  // "Access:" 줄이 두 개 존재 — 하나는 권한, 하나는 타임스탬프
  const lines       = raw.split("\n");
  const accessLine  = lines.find(l => /^\s*Access:\s+\d{4}/.test(l));
  const modifyLine  = lines.find(l => /^\s*Modify:/.test(l));
  const changeLine  = lines.find(l => /^\s*Change:/.test(l));
  const birthLine   = lines.find(l => /Birth:/.test(l));

  const named = splitFileLine(fileMatch[1]!);
  return {
    file:        named.file,
    size_bytes:  parseInt(sizeMatch[1]!,    10),
    blocks:      blocksMatch   ? parseInt(blocksMatch[1]!,   10) : 0,
    io_block:    ioBlockMatch  ? parseInt(ioBlockMatch[1]!,  10) : 0,
    file_type:   fileTypeMatch ? fileTypeMatch[1]!.trim()        : "",
    inode:       inodeMatch    ? parseInt(inodeMatch[1]!,    10) : 0,
    links:       linksMatch    ? parseInt(linksMatch[1]!,    10) : 0,
    permissions: permMatch     ? permMatch[1]!.trim()            : "",
    uid:         uidMatch      ? parseInt(uidMatch[1]!,      10) : 0,
    uid_name:    uidMatch      ? uidMatch[2]!.trim()             : "",
    gid:         gidMatch      ? parseInt(gidMatch[1]!,      10) : 0,
    gid_name:    gidMatch      ? gidMatch[2]!.trim()             : "",
    accessed_at: accessLine    ? accessLine.replace(/^\s*Access:\s+/, "").trim() : "",
    modified_at: modifyLine    ? modifyLine.replace(/^\s*Modify:\s+/, "").trim() : "",
    changed_at:  changeLine    ? changeLine.replace(/^\s*Change:\s+/, "").trim() : "",
    birth_at:    birthLine     ? birthLine.replace(/^\s*Birth:\s+/,   "").trim() : "",
    ...(named.link_target !== undefined && { link_target: named.link_target }),
  };
}

/** File: 줄마다 구간을 나눠 파싱한다. 파일이 하나면 StatResult, 여럿이면 { files }. 읽지 못한 구간이 있으면 줄 목록이다. */
export function parseStat(cmd: string, args: string[], raw: string): StatResult | StatMany | { lines: string[] } {
  const fallback = { lines: raw.split("\n").filter(Boolean) };

  const macosLines = raw.split("\n").filter(l => l.trim());
  const macos      = macosLines.map(parseStatMacos);
  if (macos.length > 0 && macos.every(r => r !== null)) {
    return macos.length === 1 ? macos[0]! : { files: macos as StatResult[] };
  }

  const blocks = raw.split(/(?=^\s*File:)/m).filter(b => b.trim());
  const parsed = blocks.map(parseStatBlock);
  if (parsed.length === 0 || parsed.some(r => r === null)) return fallback;
  return parsed.length === 1 ? parsed[0]! : { files: parsed as StatResult[] };
}
