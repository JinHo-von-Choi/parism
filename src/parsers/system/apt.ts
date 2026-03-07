/**
 * apt list --installed 출력 파싱.
 * 형식: package/version arch [설치됨,자동]
 *
 * @author 최진호
 * @date 2026-03-07
 */

import type { ParseContext } from "../registry.js";

export interface AptPackage {
  name:    string;
  version: string;
  arch:    string;
  status:  string;
}

export interface AptResult {
  packages: AptPackage[];
}

const PKG_LINE = /^([^\s]+)\s+(\S+)\s+(\S+)\s+\[([^\]]+)\]$/;

/**
 * apt list --installed 출력을 파싱한다.
 */
export function parseApt(
  _cmd: string,
  _args: string[],
  raw: string,
  ctx?: ParseContext,
): AptResult | { lines: string[] } {
  const lines = raw.split("\n").filter(Boolean);
  const packages: AptPackage[] = [];

  for (const line of lines) {
    if (line.startsWith("나열 중") || line.startsWith("Listing")) continue;

    const m = line.match(PKG_LINE);
    if (!m) continue;

    const namePart = (m[1] ?? "").split(",")[0] ?? "";
    const version  = (m[2] ?? "").replace(/^now\s+/, "");

    packages.push({
      name:    namePart.trim(),
      version: version.trim(),
      arch:    m[3] ?? "",
      status:  m[4] ?? "",
    });
  }

  if (packages.length === 0 && lines.length > 0) return { lines };

  const maxItems = ctx?.maxItems ?? 0;
  const result = maxItems > 0 && packages.length > maxItems
    ? packages.slice(0, maxItems)
    : packages;

  return { packages: result };
}
