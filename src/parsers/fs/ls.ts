import type { ParseContext } from "../registry.js";

export interface LsEntry {
  permissions: string;
  links:       number;
  owner:       string;
  group:       string;
  size_bytes:  number;
  modified_at: string;
  name:        string;
  type:        "file" | "directory" | "symlink" | "char_device" | "block_device" | "other";
  target:      string | null;
  /** -R이나 피연산자 둘 이상의 구획 머리줄("./sub:")에서 얻은 디렉터리. 구획 밖(파일 피연산자)의 항목에는 없다. */
  directory?:  string;
}

export interface LsSummary {
  total:     number;
  shown:     number;
  truncated: boolean;
}

/** 수정 시각 모양: 기본("Oct  3 06:45", "Oct  3  2025"), long-iso, --full-time */
const MTIME = "\\w+\\s+\\d+\\s+[\\d:]+|\\d{4}-\\d{2}-\\d{2}\\s+\\d{2}:\\d{2}(?::\\d{2}\\.\\d+\\s+[+-]\\d{4})?";

/** 시각 열 다음에는 공백 한 칸 뒤 이름이 온다. 이름 앞뒤의 공백은 이름의 일부다. */
const LONG_LINE = new RegExp(`^([bcdlps-])([rwxsStT-]{9})[.+@]?\\s+(\\d+)\\s+(\\S+)\\s+(\\S+)\\s+(\\d+(?:,\\s*\\d+)?)\\s+(${MTIME}) (.+)$`);

/** 구획 머리줄("./sub:", "dir with space:"). 긴 형식에서 항목 줄은 권한 문자열로 시작하므로 그 줄은 머리줄이 아니다. */
const SECTION_HEADER = /^(?![bcdlps-][rwxsStT-]{9})(\S.*):$/;

/** 표시 구분 기호 방식: -F/--indicator-style=classify는 classify, -p/--indicator-style=slash는 slash */
function indicatorMode(args: string[]): "none" | "slash" | "classify" {
  let mode: "none" | "slash" | "classify" = "none";
  for (const a of args) {
    if (a === "--") break;
    if (a.startsWith("--indicator-style=")) {
      const v = a.slice(18);
      mode = v === "classify" ? "classify" : v === "slash" ? "slash" : "none";
    } else if (/^-[A-Za-z]+$/.test(a)) {
      for (const c of a.slice(1)) { if (c === "F") mode = "classify"; else if (c === "p") mode = "slash"; }
    }
  }
  return mode;
}

/** 이름 끝의 표시 구분 기호를 걷어 낸다. 기호는 파일 종류에서 정해지므로 종류가 맞을 때만 뗀다. */
function stripIndicator(name: string, typeChar: string, perms: string, mode: "none" | "slash" | "classify"): string {
  if (mode === "none") return name;
  if (typeChar === "d" && name.endsWith("/")) return name.slice(0, -1);
  if (mode !== "classify") return name;
  if (typeChar === "p" && name.endsWith("|")) return name.slice(0, -1);
  if (typeChar === "s" && name.endsWith("=")) return name.slice(0, -1);
  if (typeChar === "-" && name.endsWith("*") && [2, 5, 8].some(i => "xst".includes(perms[i]!))) return name.slice(0, -1);
  return name;
}

/** 심볼릭 링크 대상 끝의 표시 구분 기호(대상 종류에서 정해진다)를 걷어 낸다. */
function stripTargetIndicator(target: string, mode: "none" | "slash" | "classify"): string {
  if (mode === "slash") return target.replace(/\/$/, "");
  if (mode === "classify") return target.replace(/[*/=>@|]$/, "");
  return target;
}

export function parseLs(
  cmd: string, args: string[], raw: string, ctx?: ParseContext,
): { entries: LsEntry[]; _summary?: LsSummary } {
  const entries: LsEntry[] = [];
  const mode = indicatorMode(args);
  let directory: string | undefined;

  for (const line of raw.split("\n")) {
    if (!line || line.startsWith("total ")) continue;

    const m = LONG_LINE.exec(line);
    if (!m) {
      const header = SECTION_HEADER.exec(line);
      if (header) directory = header[1];
      continue;
    }

    const [, typeChar, perms, links, owner, group, size, mtime, rawName] = m as unknown as string[];

    const isDevice = typeChar === "c" || typeChar === "b";
    const arrow    = typeChar === "l" ? rawName.indexOf(" -> ") : -1;
    const name     = stripIndicator(arrow >= 0 ? rawName.slice(0, arrow) : rawName, typeChar, perms, mode);
    const target   = arrow >= 0 ? stripTargetIndicator(rawName.slice(arrow + 4), mode) : null;

    entries.push({
      permissions: typeChar + perms,
      links:       parseInt(links, 10),
      owner,
      group,
      size_bytes:  isDevice ? 0 : parseInt(size, 10),
      modified_at: mtime.trim(),
      name,
      type:        typeChar === "d" ? "directory"
                 : typeChar === "l" ? "symlink"
                 : typeChar === "-" ? "file"
                 : typeChar === "c" ? "char_device"
                 : typeChar === "b" ? "block_device"
                 : "other",
      target,
      ...(directory !== undefined && { directory }),
    });
  }

  const maxItems = ctx?.maxItems ?? 0;
  if (maxItems > 0 && entries.length > maxItems) {
    return {
      entries:  entries.slice(0, maxItems),
      _summary: { total: entries.length, shown: maxItems, truncated: true },
    };
  }
  return { entries };
}
