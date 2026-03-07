/**
 * npm list / pnpm list / yarn list 출력 파싱.
 * 트리 형식: ├── name@version, └── name@version
 *
 * @author 최진호
 * @date 2026-03-07
 */

import type { ParseContext } from "../registry.js";

export interface NpmDependency {
  name:    string;
  version: string;
  depth:   number;
}

export interface NpmResult {
  dependencies: NpmDependency[];
}

const TREE_LINE = /^[├└│\s]*──\s+(.+?)(?:@(\S+))?\s*$/;

/**
 * npm list / pnpm list 트리 출력을 파싱한다.
 */
export function parseNpm(
  _cmd: string,
  _args: string[],
  raw: string,
  ctx?: ParseContext,
): NpmResult | { lines: string[] } {
  const lines = raw.split("\n").filter(Boolean);
  const dependencies: NpmDependency[] = [];

  for (const line of lines) {
    const m = line.match(TREE_LINE);
    if (!m) continue;

    const name    = (m[1] ?? "").trim();
    const version = (m[2] ?? "").trim();
    const depth   = (line.match(/[├└│]/g)?.length ?? 0);

    if (!name) continue;

    dependencies.push({
      name,
      version: version || "",
      depth,
    });
  }

  if (dependencies.length === 0 && lines.length > 0) return { lines };

  const maxItems = ctx?.maxItems ?? 0;
  const result = maxItems > 0 && dependencies.length > maxItems
    ? dependencies.slice(0, maxItems)
    : dependencies;

  return { dependencies: result };
}
