/**
 * helm list 출력 파싱.
 *
 * @author 최진호
 * @date 2026-03-07
 */

import type { ParseContext } from "../registry.js";

export interface HelmRelease {
  name:         string;
  namespace:   string;
  revision:    number;
  updated:     string;
  status:      string;
  chart:       string;
  app_version: string;
}

export interface HelmResult {
  releases: HelmRelease[];
}

const HEADER = /NAME\s+NAMESPACE\s+REVISION\s+UPDATED\s+STATUS\s+CHART\s+APP VERSION/i;

/**
 * helm list 출력을 파싱한다.
 * 탭 또는 2+ 공백으로 구분된 컬럼.
 */
export function parseHelm(
  _cmd: string,
  _args: string[],
  raw: string,
  ctx?: ParseContext,
): HelmResult | { lines: string[] } {
  const lines = raw.split("\n").filter(Boolean);
  if (lines.length === 0) return { releases: [] };
  if (!lines.some(l => HEADER.test(l))) return { lines };

  const headerIdx = lines.findIndex(l => HEADER.test(l));
  const dataLines = lines.slice(headerIdx + 1);

  const releases: HelmRelease[] = [];
  for (const line of dataLines) {
    const cols = line.split(/\t|\s{2,}/).map(s => s.trim()).filter(Boolean);
    if (cols.length < 7) continue;

    releases.push({
      name:         cols[0] ?? "",
      namespace:    cols[1] ?? "",
      revision:     parseInt(cols[2] ?? "0", 10) || 0,
      updated:      cols[3] ?? "",
      status:       cols[4] ?? "",
      chart:        cols[5] ?? "",
      app_version:  cols[6] ?? "",
    });
  }

  const maxItems = ctx?.maxItems ?? 0;
  const result = maxItems > 0 && releases.length > maxItems
    ? releases.slice(0, maxItems)
    : releases;

  return { releases: result };
}
