import type { ParseContext } from "../registry.js";

export interface FindSummary {
  total:     number;
  shown:     number;
  truncated: boolean;
}

export function parseFind(
  cmd: string, args: string[], raw: string, ctx?: ParseContext,
): { paths: string[]; _summary?: FindSummary } {
  const terminator = args.includes("-print0") ? "\0" : "\n";
  const paths = raw.split(terminator).map(l => (terminator === "\0" ? l : l.trim())).filter(Boolean);

  const maxItems = ctx?.maxItems ?? 0;
  if (maxItems > 0 && paths.length > maxItems) {
    return {
      paths:    paths.slice(0, maxItems),
      _summary: { total: paths.length, shown: maxItems, truncated: true },
    };
  }
  return { paths };
}
