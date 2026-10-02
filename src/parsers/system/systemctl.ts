/**
 * systemctl list-units 출력 파싱.
 * Linux 전용. macOS/Windows는 { lines } 폴백.
 *
 * @author 최진호
 * @date 2026-03-07
 */

import type { ParseContext } from "../registry.js";

export interface SystemctlUnit {
  name:         string;
  load:         string;
  active:       string;
  sub:          string;
  description:  string;
  failed?:      boolean;
}

export interface SystemctlResult {
  units: SystemctlUnit[];
}

const HEADER_PATTERN = /^\s*UNIT\s+LOAD\s+ACTIVE\s+SUB\s+DESCRIPTION\s*$/i;

/**
 * systemctl list-units 출력을 파싱한다.
 * 헤더(UNIT LOAD ACTIVE SUB DESCRIPTION) 다음 행부터 유닛 정보 추출.
 */
export function parseSystemctl(
  _cmd: string,
  _args: string[],
  raw: string,
  ctx?: ParseContext,
): SystemctlResult | { lines: string[] } {
  const lines = raw.split("\n").filter(Boolean);
  if (lines.length === 0) return { units: [] };

  const allLines  = raw.split("\n");
  const headerIdx = allLines.findIndex(l => HEADER_PATTERN.test(l));
  if (headerIdx < 0) return { lines };

  /** 유닛 이름은 공백을 이스케이프하므로 앞 4열은 공백 1개 이상으로 구분된다. 첫 빈 줄 뒤는 범례다. */
  const units: SystemctlUnit[] = [];
  for (const line of allLines.slice(headerIdx + 1)) {
    const trimmed = line.trim();
    if (!trimmed) break;

    const failed  = /^[●*]\s/.test(trimmed);
    const content = (failed ? trimmed.slice(1) : trimmed).trim();

    const m = content.match(/^(\S+)\s+(\S+)\s+(\S+)\s+(\S+)(?:\s+(.*))?$/);
    if (!m) continue;

    units.push({
      name:        m[1]!,
      load:        m[2]!,
      active:      m[3]!,
      sub:         m[4]!,
      description: (m[5] ?? "").trim(),
      failed:      failed || undefined,
    });
  }

  const maxItems = ctx?.maxItems ?? 0;
  const result = maxItems > 0 && units.length > maxItems
    ? units.slice(0, maxItems)
    : units;

  return { units: result };
}
