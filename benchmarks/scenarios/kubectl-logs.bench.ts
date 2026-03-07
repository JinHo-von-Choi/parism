import type { Scenario, ExtractionResult } from "../types.js";

/**
 * raw kubectl logs 출력에서 ERROR/WARN 라인 추출.
 * 비정형 텍스트 케이스 — 로그는 구조화 불가.
 */
function extractRawKubectlLogs(raw: string): ExtractionResult {
  const start = Date.now();
  try {
    const lines  = raw.split("\n").filter(Boolean);
    const issues = lines
      .filter(l => l.includes(" ERROR ") || l.includes(" WARN "))
      .map(l => {
        const match = l.match(/^(\S+)\s+(ERROR|WARN)\s+\[([^\]]+)\]\s+(.+)$/);
        return match
          ? { timestamp: match[1], level: match[2], component: match[3], message: match[4] }
          : { raw: l };
      });
    return { success: true, data: issues, timeMs: Date.now() - start };
  } catch (e) {
    return { success: false, data: null, timeMs: Date.now() - start, errorMsg: String(e) };
  }
}

export const kubectlLogsScenario: Scenario = {
  name:        "kubectl logs — unstructured log text (no Parism parser)",
  description: "컨테이너 로그 비정형 텍스트. Parism 파서 없음. raw와 동일 비용 구조. 에러/경고 감지 시나리오.",
  riskLevel:   "none",

  fixturePath:  "kubectl-logs.txt",
  extractRaw:   extractRawKubectlLogs,
  parserArgs:   ["logs"],

  rawContextPrompt: `kubectl logs 출력에서 ERROR와 WARN 레벨 로그를 추출하세요.
각 항목의 timestamp, level, component, message를 반환하세요.
로그 형식: TIMESTAMP LEVEL [COMPONENT] MESSAGE`,

  jsonContextPrompt: `stdout.parsed가 null입니다 — kubectl logs는 Parism 파서가 없어 구조화 불가.
stdout.raw에서 직접 ERROR/WARN 패턴을 추출하세요.`,
};
