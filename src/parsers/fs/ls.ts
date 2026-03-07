import type { ParseContext } from "../registry.js";

export interface LsEntry {
  permissions: string;
  links:       number;
  owner:       string;
  group:       string;
  size_bytes:  number;
  modified_at: string;
  name:        string;
  type:        "file" | "directory" | "symlink" | "other";
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
      /^([dlbcsp-])([rwx-]{9})\s+(\d+)\s+(\S+)\s+(\S+)\s+(\d+)\s+(\w+\s+\d+\s+[\d:]+)\s+(.+)$/,
    );
    if (!m) continue;

    const [, typeChar, perms, links, owner, group, size, mtime, name] = m;

    entries.push({
      permissions: typeChar + perms,
      links:       parseInt(links, 10),
      owner,
      group,
      size_bytes:  parseInt(size, 10),
      modified_at: mtime.trim(),
      name:        name.trim(),
      type:        typeChar === "d" ? "directory"
                 : typeChar === "l" ? "symlink"
                 : typeChar === "-" ? "file"
                 : "other",
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
