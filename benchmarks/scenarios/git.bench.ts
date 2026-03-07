import type { Scenario, ExtractionResult } from "../types.js";

function extractRawGitLog(raw: string): ExtractionResult {
  const start = Date.now();
  try {
    const entries = raw.split("\n").filter(Boolean).map(line => {
      const spaceIdx = line.indexOf(" ");
      if (spaceIdx < 0) throw new Error(`malformed line: ${line}`);
      return {
        hash:    line.slice(0, spaceIdx),
        message: line.slice(spaceIdx + 1),
      };
    });
    return { success: true, data: entries, timeMs: Date.now() - start };
  } catch (e) {
    return { success: false, data: null, timeMs: Date.now() - start, errorMsg: String(e) };
  }
}

export const gitLogScenario: Scenario = {
  name:        "git log --oneline",
  description: "커밋 해시와 메시지 추출",
  riskLevel:   "minor",
  fixturePath: "git-log.txt",
  extractRaw:  extractRawGitLog,
  parserArgs:  ["log"],

  rawContextPrompt: `git log --oneline 출력을 파싱하세요.
형식: [7자리 해시] [커밋 메시지]
첫 공백을 기준으로 해시와 메시지를 분리하세요.`,

  jsonContextPrompt: `stdout.parsed.commits 배열을 사용하세요.
각 항목: hash, message`,
};
