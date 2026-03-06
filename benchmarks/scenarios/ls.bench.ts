import { parseLs }   from "../../src/parsers/fs/ls.js";
import type { Scenario, ExtractionResult } from "../types.js";

/**
 * raw ls -la 출력에서 파일 목록을 추출하는 regex 기반 시뮬레이터.
 * LLM이 raw 텍스트를 받았을 때 해야 하는 작업의 근사치.
 * 핵심 취약점: 공백 기준 split은 공백 포함 파일명을 잘라낸다.
 */
function extractRawLs(raw: string): ExtractionResult {
  const start = Date.now();
  try {
    const lines = raw.split("\n").filter(l => l && !l.startsWith("total "));
    const entries = lines.map(line => {
      const parts = line.split(/\s+/);
      if (parts.length < 9) return null;
      const name     = parts[8];  // 공백 포함 파일명 시 잘림
      const typeChar = parts[0]?.[0];
      const type     = typeChar === "d" ? "directory"
                     : typeChar === "l" ? "symlink"
                     : "file";
      const sizeStr  = parts[4] ?? "0";
      return { name, type, size_bytes: parseInt(sizeStr, 10) };
    }).filter(Boolean);

    return { success: true, data: entries, timeMs: Date.now() - start };
  } catch (e) {
    return {
      success:  false,
      data:     null,
      timeMs:   Date.now() - start,
      errorMsg: String(e),
    };
  }
}

/**
 * Parism parseLs를 사용하는 JSON 추출기.
 * cmd와 args는 고정값 사용 (fixture는 ls -la 출력).
 */
function extractJsonLs(raw: string): ExtractionResult {
  const start = Date.now();
  try {
    const result = parseLs("ls", ["-la"], raw);
    return { success: true, data: result, timeMs: Date.now() - start };
  } catch (e) {
    return {
      success:  false,
      data:     null,
      timeMs:   Date.now() - start,
      errorMsg: String(e),
    };
  }
}

export const lsNormalScenario: Scenario = {
  name:        "ls: normal filenames",
  description: "일반 파일명(공백 없음)에서 파일 목록 추출",
  fixturePath: "ls-normal.txt",
  extractRaw:  extractRawLs,

  rawContextPrompt: `ls -la 명령 출력을 파싱하세요.
형식: [권한] [링크수] [소유자] [그룹] [크기] [월] [일] [시각] [파일명]
- 첫 번째 문자: d=디렉토리, l=심볼릭링크, -=파일
- total로 시작하는 줄은 무시
파일명, 타입, 크기(bytes)를 추출하세요.`,

  jsonContextPrompt: `stdout.parsed.entries 배열을 사용하세요.
각 항목: name, type("file"|"directory"|"symlink"), size_bytes, permissions, owner, modified_at`,
};

export const lsSpacesScenario: Scenario = {
  name:        "ls: filenames with spaces (edge case)",
  description: "공백 포함 파일명 — raw split이 파일명을 잘라내는 구조적 취약점 시연",
  fixturePath: "ls-spaces.txt",
  extractRaw:  extractRawLs,  // 공백 포함 파일명에서 파일명이 잘림
  expectedNames: [
    ".",
    "..",
    "my report 2026.pdf",
    "config final (2).json",
    "project files backup",
    "notes - draft v3.txt",
    ".env",
  ],

  rawContextPrompt: `ls -la 명령 출력을 파싱하세요.
형식: [권한] [링크수] [소유자] [그룹] [크기] [월] [일] [시각] [파일명]
주의: 파일명에 공백이 포함될 수 있습니다.
파일명을 올바르게 추출하려면 앞 8개 필드(공백 구분)를 파싱한 뒤 나머지 전체를 파일명으로 취급해야 합니다.
단순 공백 split으로는 파일명이 잘립니다.
파일명, 타입, 크기(bytes)를 추출하세요.`,

  jsonContextPrompt: `stdout.parsed.entries 배열을 사용하세요.
각 항목: name(공백 포함 파일명도 정확히 보존됨), type, size_bytes`,
};
