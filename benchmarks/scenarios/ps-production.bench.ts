import type { Scenario, ExtractionResult } from "../types.js";

/**
 * raw ps aux 출력에서 프로세스 목록 추출.
 * Linux에서 컬럼 순서가 고정되어 있어 공백 split 신뢰도 높음.
 * COMMAND 컬럼은 공백 포함 가능하지만 마지막 컬럼이므로 join으로 복원 가능.
 */
function extractRawPs(raw: string): ExtractionResult {
  const start = Date.now();
  try {
    const lines = raw.split("\n").filter(Boolean);
    const dataLines = lines.filter(l => !l.startsWith("USER"));
    const processes = dataLines.map(line => {
      const parts = line.trim().split(/\s+/);
      if (parts.length < 11) return null;
      return {
        user:    parts[0],
        pid:     parseInt(parts[1] ?? "0", 10),
        cpu:     parseFloat(parts[2] ?? "0"),
        mem:     parseFloat(parts[3] ?? "0"),
        command: parts.slice(10).join(" "),
      };
    }).filter(Boolean);
    return { success: true, data: processes, timeMs: Date.now() - start };
  } catch (e) {
    return { success: false, data: null, timeMs: Date.now() - start, errorMsg: String(e) };
  }
}

export const psProductionScenario: Scenario = {
  name:        "ps: production server (120 processes)",
  description: "실제 프로덕션 서버 — 120개 프로세스 (nginx, node.js, postgres, redis, 시스템 데몬). 정적 컬럼, raw 파싱 안정.",
  riskLevel:   "major",

  fixturePath: "ps-production.txt",
  extractRaw:  extractRawPs,

  rawContextPrompt: `ps aux 명령 출력을 파싱하세요.
컬럼 순서 (고정): USER PID %CPU %MEM VSZ RSS TTY STAT START TIME COMMAND
헤더(USER로 시작) 줄은 무시하세요.
COMMAND 컬럼은 10번째 컬럼 이후 전체 (공백 포함 가능).
각 프로세스의 user, pid, %cpu, %mem, command를 추출하세요.`,

  jsonContextPrompt: `stdout.parsed.processes 배열을 사용하세요.
각 항목: user, pid, cpu_percent, mem_percent, vsz, rss, stat, start, time, command`,
};
