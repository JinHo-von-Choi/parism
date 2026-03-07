/**
 * terraform plan 출력 요약 파싱.
 * Plan: X to add, Y to change, Z to destroy 라인 추출.
 *
 * @author 최진호
 * @date 2026-03-07
 */

export interface TerraformPlanSummary {
  to_add:     number;
  to_change:  number;
  to_destroy: number;
}

export interface TerraformResult {
  summary: TerraformPlanSummary;
}

const PLAN_LINE = /Plan:\s*(\d+)\s+to\s+add,\s*(\d+)\s+to\s+change,\s*(\d+)\s+to\s+destroy/i;

/**
 * terraform plan 텍스트 출력에서 Plan: 라인을 파싱한다.
 */
export function parseTerraform(
  _cmd: string,
  _args: string[],
  raw: string,
): TerraformResult | { lines: string[] } {
  const lines = raw.split("\n").filter(Boolean);
  if (lines.length === 0) return { lines: [] };

  const planLine = lines.find(l => PLAN_LINE.test(l));
  if (!planLine) return { lines };

  const m = planLine.match(PLAN_LINE);
  if (!m) return { lines };

  return {
    summary: {
      to_add:     parseInt(m[1] ?? "0", 10) || 0,
      to_change:  parseInt(m[2] ?? "0", 10) || 0,
      to_destroy: parseInt(m[3] ?? "0", 10) || 0,
    },
  };
}
