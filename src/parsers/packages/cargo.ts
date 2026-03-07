/**
 * cargo tree / cargo list 출력 파싱.
 * 트리 형식: name version 또는 ├── name version
 *
 * @author 최진호
 * @date 2026-03-07
 */

import type { ParseContext } from "../registry.js";

export interface CargoCrate {
  name:    string;
  version: string;
  path?:   string;
}

export interface CargoResult {
  crates: CargoCrate[];
}

const TREE_LINE = /^[├└│\s]*──\s*(\S+)\s+(\S+)(?:\s+\((.+)\))?\s*$/;
const SIMPLE_LINE = /^(\S+)\s+([\w.+-]+)\s*$/;

/**
 * cargo tree 출력을 파싱한다.
 */
export function parseCargo(
  _cmd: string,
  _args: string[],
  raw: string,
  ctx?: ParseContext,
): CargoResult | { lines: string[] } {
  const lines = raw.split("\n").filter(Boolean);
  const crates: CargoCrate[] = [];

  for (const line of lines) {
    let m = line.match(TREE_LINE);
    if (!m) m = line.match(SIMPLE_LINE);
    if (!m) continue;

    const name    = m[1] ?? "";
    const version = (m[2] ?? "").replace(/[()]/g, "");
    const path    = m[3]?.trim();

    if (!name || name === "(*)" || /^[├└│─]/.test(name)) continue;

    crates.push({
      name,
      version,
      path: path || undefined,
    });
  }

  if (crates.length === 0 && lines.length > 0) return { lines };

  const maxItems = ctx?.maxItems ?? 0;
  const result = maxItems > 0 && crates.length > maxItems
    ? crates.slice(0, maxItems)
    : crates;

  return { crates: result };
}
