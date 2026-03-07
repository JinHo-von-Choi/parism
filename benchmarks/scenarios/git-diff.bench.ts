import type { Scenario, ExtractionResult } from "../types.js";

/**
 * raw git diff 출력에서 변경된 파일명 추출.
 * 비정형 텍스트 케이스 — Parism이 구조화 파서를 제공하지 않는 영역.
 * parserArgs: ["diff"] → defaultRegistry는 git diff 파서가 없으므로 null 반환.
 */
function extractRawGitDiff(raw: string): ExtractionResult {
  const start = Date.now();
  try {
    const lines     = raw.split("\n");
    const fileLines = lines.filter(l => l.startsWith("diff --git "));
    const files     = fileLines.map(l => {
      const match = l.match(/diff --git a\/(.+) b\//);
      return match ? { name: match[1] } : null;
    }).filter(Boolean);
    return { success: true, data: files, timeMs: Date.now() - start };
  } catch (e) {
    return { success: false, data: null, timeMs: Date.now() - start, errorMsg: String(e) };
  }
}

export const gitDiffScenario: Scenario = {
  name:        "git diff — unstructured text (no Parism parser)",
  description: "비정형 텍스트 케이스. Parism에 git diff 파서가 없으므로 parsed=null. raw pass-through와 동일 비용.",
  riskLevel:   "none",

  fixturePath:  "git-diff.txt",
  extractRaw:   extractRawGitDiff,
  parserArgs:   ["diff"],

  expectedNames: ["src/server.ts", "src/guard.ts", "src/parsers/index.ts"],

  rawContextPrompt: `git diff 출력에서 변경된 파일 목록을 추출하세요.
"diff --git a/파일경로 b/파일경로" 패턴에서 파일명을 추출합니다.
각 변경 파일의 경로와 변경 유형(추가/수정/삭제)을 반환하세요.`,

  jsonContextPrompt: `stdout.parsed가 null입니다 — git diff는 Parism 파서가 없어 구조화 불가.
stdout.raw에서 직접 "diff --git" 패턴을 파싱하세요.`,
};
