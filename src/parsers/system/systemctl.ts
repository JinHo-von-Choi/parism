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

  const headerIdx = lines.findIndex(l => HEADER_PATTERN.test(l));
  if (headerIdx < 0) return { lines: raw.split("\n").filter(Boolean) };
  const dataLines = lines.slice(headerIdx + 1);

  const units: SystemctlUnit[] = [];
  for (const line of dataLines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    const failed = trimmed.startsWith("●");
    const content = (failed ? trimmed.slice(1) : trimmed).trim();

    const parts = content.split(/\s{2,}/);
    if (parts.length < 4) continue;

    const [name, load, active, rest] = parts;
    const restWords = (rest ?? "").trim().split(/\s+/);
    const sub         = restWords[0] ?? "";
    const description = restWords.slice(1).join(" ").trim();

    units.push({
      name:        name?.trim() ?? "",
      load:        load?.trim() ?? "",
      active:      active?.trim() ?? "",
      sub:         sub?.trim() ?? "",
      description,
      failed:      failed || undefined,
    });
  }

  const maxItems = ctx?.maxItems ?? 0;
  const result = maxItems > 0 && units.length > maxItems
    ? units.slice(0, maxItems)
    : units;

  return { units: result };
}
