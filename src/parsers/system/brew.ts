/**
 * brew list --versions 출력 파싱.
 * 형식: name version (한 줄에 하나)
 *
 * @author 최진호
 * @date 2026-03-07
 */

import type { ParseContext } from "../registry.js";

export interface BrewPackage {
  name:    string;
  version: string;
}

export interface BrewResult {
  packages: BrewPackage[];
}

/**
 * brew list --versions 출력을 파싱한다.
 */
export function parseBrew(
  _cmd: string,
  _args: string[],
  raw: string,
  ctx?: ParseContext,
): BrewResult | { lines: string[] } {
  const lines = raw.split("\n").filter(Boolean);
  const packages: BrewPackage[] = [];

  for (const line of lines) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 2) continue;

    packages.push({
      name:    parts[0] ?? "",
      version: parts[1] ?? "",
    });
  }

  if (packages.length === 0 && lines.length > 0) return { lines };

  const maxItems = ctx?.maxItems ?? 0;
  const result = maxItems > 0 && packages.length > maxItems
    ? packages.slice(0, maxItems)
    : packages;

  return { packages: result };
}
