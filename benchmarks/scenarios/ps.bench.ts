import type { Scenario, ExtractionResult } from "../types.js";

function extractRawPs(raw: string): ExtractionResult {
  const start = Date.now();
  try {
    const lines = raw.split("\n").filter(Boolean);
    if (lines.length < 2) throw new Error("empty output");
    // Linux ps aux: USER PID %CPU %MEM VSZ RSS TTY STAT START TIME COMMAND
    const entries = lines.slice(1).map(line => {
      const parts = line.trim().split(/\s+/);
      return {
        pid:     parts[1],
        cpu:     parseFloat(parts[2] ?? "0"),
        mem:     parseFloat(parts[3] ?? "0"),
        command: parts.slice(10).join(" "),  // COMMAND may contain spaces
      };
    });
    return { success: true, data: entries, timeMs: Date.now() - start };
  } catch (e) {
    return { success: false, data: null, timeMs: Date.now() - start, errorMsg: String(e) };
  }
}

export const psScenario: Scenario = {
  name:        "ps aux: process list",
  description: "프로세스 목록에서 PID, CPU%, COMMAND 추출",
  riskLevel:   "major",
  fixturePath: "ps-aux.txt",
  extractRaw:  extractRawPs,

  rawContextPrompt: `ps aux 출력을 파싱하세요.
Linux 컬럼 순서: USER PID %CPU %MEM VSZ RSS TTY STAT START TIME COMMAND
- COMMAND는 10번째 인덱스부터 끝까지(공백 포함 가능)
- macOS에서 컬럼 순서가 다를 수 있음
PID, %CPU, COMMAND를 추출하세요.`,

  jsonContextPrompt: `stdout.parsed.processes 배열을 사용하세요.
각 항목: pid, cpu_percent, mem_percent, command`,
};
