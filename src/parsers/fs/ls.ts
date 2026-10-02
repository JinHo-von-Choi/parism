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
}

export interface LsSummary {
  total:     number;
  shown:     number;
  truncated: boolean;
}

export function parseLs(
  cmd: string, args: string[], raw: string, ctx?: ParseContext,
): { entries: LsEntry[]; _summary?: LsSummary } {
  const entries: LsEntry[] = [];

  for (const line of raw.split("\n")) {
    if (!line || line.startsWith("total ")) continue;

    const m = line.match(
      /^([bcdlps-])([rwxsStT-]{9})[.+@]?\s+(\d+)\s+(\S+)\s+(\S+)\s+(\d+(?:,\s*\d+)?)\s+(\w+\s+\d+\s+[\d:]+)\s+(.+)$/,
    );
    if (!m) continue;

    const [, typeChar, perms, links, owner, group, size, mtime, rawName] = m;

    const isDevice = typeChar === "c" || typeChar === "b";
    const arrow    = typeChar === "l" ? rawName.indexOf(" -> ") : -1;
    const name     = arrow >= 0 ? rawName.slice(0, arrow) : rawName;
    const target   = arrow >= 0 ? rawName.slice(arrow + 4) : null;

    entries.push({
      permissions: typeChar + perms,
      links:       parseInt(links, 10),
      owner,
      group,
      size_bytes:  isDevice ? 0 : parseInt(size, 10),
      modified_at: mtime.trim(),
      name:        name.trim(),
      type:        typeChar === "d" ? "directory"
                 : typeChar === "l" ? "symlink"
                 : typeChar === "-" ? "file"
                 : typeChar === "c" ? "char_device"
                 : typeChar === "b" ? "block_device"
                 : "other",
      target,
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
