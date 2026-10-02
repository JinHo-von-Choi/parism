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
  job?:         string;
  failed?:      boolean;
}

export interface SystemctlResult {
  units: SystemctlUnit[];
}

const HEADER_PATTERN = /^\s*UNIT\s+LOAD\s+ACTIVE\s+SUB\s+(?:JOB\s+)?DESCRIPTION\s*$/i;

/** 행 앞의 표시 기호(●, ○, *, ×)를 뗀다. 유닛 이름은 한 글자짜리 기호로 시작하지 않는다. */
function stripMark(trimmed: string): string {
  const first = trimmed.split(/\s+/, 1)[0] ?? "";
  return first.length === 1 && !/[A-Za-z0-9]/.test(first) ? trimmed.slice(1).trim() : trimmed;
}

/**
 * systemctl list-units 출력을 파싱한다.
 * 헤더(UNIT LOAD ACTIVE SUB [JOB] DESCRIPTION) 다음 행부터 유닛 정보 추출. --no-legend이면 헤더와 범례가 없고 모든 줄이 행이다.
 * 대기 중인 작업이 있으면 systemctl이 JOB 열을 추가하므로, 그때는 헤더 열 위치로 JOB과 DESCRIPTION을 자른다(헤더가 없으면 JOB을 알 수 없다).
 * failed는 ACTIVE 열이 failed인 유닛이다. 행 앞의 기호는 not-found 같은 로드 문제에도 붙으므로 실패 표시로 쓰지 않는다.
 */
export function parseSystemctl(
  _cmd: string,
  args: string[],
  raw: string,
  ctx?: ParseContext,
): SystemctlResult | { lines: string[] } {
  const lines = raw.split("\n").filter(Boolean);
  if (lines.length === 0) return { units: [] };

  const allLines  = raw.split("\n");
  const headerIdx = allLines.findIndex(l => HEADER_PATTERN.test(l));
  if (headerIdx < 0 && !args.includes("--no-legend")) return { lines };

  const header  = headerIdx >= 0 ? allLines[headerIdx]! : "";
  const jobCol  = header.search(/\bJOB\b/);
  const descCol = header.search(/\bDESCRIPTION\b/);

  /** 유닛 이름은 공백을 이스케이프하므로 앞 4열은 공백 1개 이상으로 구분된다. 첫 빈 줄 뒤는 범례다. */
  const units: SystemctlUnit[] = [];
  for (const line of allLines.slice(headerIdx + 1)) {
    const trimmed = line.trim();
    if (!trimmed) break;

    const content = stripMark(trimmed);

    const m = content.match(/^(\S+)\s+(\S+)\s+(\S+)\s+(\S+)(?:\s+(.*))?$/);
    if (!m) continue;

    const failed      = m[3] === "failed";
    const job         = jobCol >= 0 ? line.slice(jobCol, descCol).trim() : "";
    const description = jobCol >= 0 ? line.slice(descCol).trim() : (m[5] ?? "").trim();

    units.push({
      name:        m[1]!,
      load:        m[2]!,
      active:      m[3]!,
      sub:         m[4]!,
      description,
      job:         job || undefined,
      failed:      failed || undefined,
    });
  }

  const maxItems = ctx?.maxItems ?? 0;
  const result = maxItems > 0 && units.length > maxItems
    ? units.slice(0, maxItems)
    : units;

  return { units: result };
}
