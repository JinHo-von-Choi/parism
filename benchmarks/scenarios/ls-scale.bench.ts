import type { Scenario, ExtractionResult } from "../types.js";

/**
 * raw ls -la 출력에서 파일 목록 추출 — 공백 기준 split으로 9번째 컬럼만 추출.
 * 공백 포함 파일명은 첫 단어만 추출되는 구조적 취약점.
 */
function extractRawLs(raw: string): ExtractionResult {
  const start = Date.now();
  try {
    const lines = raw.split("\n").filter(l => l && !l.startsWith("total "));
    const entries = lines.map(line => {
      const parts = line.split(/\s+/);
      if (parts.length < 9) return null;
      const name     = parts[8];
      const typeChar = parts[0]?.[0];
      const type     = typeChar === "d" ? "directory"
                     : typeChar === "l" ? "symlink"
                     : "file";
      return { name, type, size_bytes: parseInt(parts[4] ?? "0", 10) };
    }).filter(Boolean);
    return { success: true, data: entries, timeMs: Date.now() - start };
  } catch (e) {
    return { success: false, data: null, timeMs: Date.now() - start, errorMsg: String(e) };
  }
}

/** ls-50-mixed: expectedNames — 50개 항목, 20개에 공백 포함 */
const expectedNames50: string[] = [
  ".", "..",
  "README.md", "package.json", "package-lock.json", "tsconfig.json",
  "src", "dist", "node_modules", ".env", ".gitignore", ".dockerignore",
  "Dockerfile", "docker-compose.yml", ".eslintrc.json", ".prettierrc",
  "jest.config.ts", "vitest.config.ts", "tests", "scripts", "docs",
  "coverage", "CHANGELOG.md", "LICENSE", ".github", "benchmarks",
  "biome.json", "tsup.config.ts", "rollup.config.ts", "SECURITY.md",
  // 공백 포함 — raw split에서 잘림
  "my report 2026.pdf",
  "project brief final.docx",
  "architecture overview.png",
  "meeting notes March.txt",
  "config backup 2026-03.json",
  "deployment guide v2.md",
  "API reference v3.pdf",
  "test data sample.csv",
  "bug report 2026-03-01.txt",
  "performance baseline.json",
  "security audit report.pdf",
  "user research notes.md",
  "sprint planning 2026-03.md",
  "database schema v4.sql",
  "release notes v0.1.6.md",
  "load test results.csv",
  "code review checklist.md",
  "infrastructure diagram.drawio",
  "onboarding guide.pdf",
  "postmortem report.md",
];

/** ls-200-mixed: expectedNames — 200개 항목, 90개에 공백 포함 */
const expectedNames200: string[] = [
  ".", "..",
  ...Array.from({ length: 108 }, (_, i) => `module_${String(i + 1).padStart(3, "0")}.ts`),
  ...Array.from({ length: 90 },  (_, i) => `user report ${String(i + 1).padStart(3, "0")}.pdf`),
];

const RAW_CTX_LS = `ls -la 명령 출력을 파싱하세요.
형식: [권한] [링크수] [소유자] [그룹] [크기] [월] [일] [시각] [파일명]
주의: 파일명에 공백이 포함될 수 있습니다. 단순 공백 split으로는 파일명이 잘립니다.
앞 8개 필드를 파싱한 뒤 나머지 전체를 파일명으로 취급해야 합니다.
total로 시작하는 줄은 무시. 파일명, 타입, 크기(bytes)를 추출하세요.`;

const JSON_CTX_LS = `stdout.parsed.entries 배열을 사용하세요.
각 항목: name(공백 포함 파일명 정확히 보존), type("file"|"directory"|"symlink"), size_bytes`;

export const lsMediumMixedScenario: Scenario = {
  name:             "ls: 50 files, 40% with spaces (medium scale)",
  description:      "중간 규모 디렉토리 — 50개 항목 중 20개 공백 포함 파일명. 정확도 60%.",
  riskLevel:        "major",
  fixturePath:      "ls-50-mixed.txt",
  extractRaw:       extractRawLs,
  expectedNames:    expectedNames50,
  rawContextPrompt: RAW_CTX_LS,
  jsonContextPrompt: JSON_CTX_LS,
};

export const lsLargeMixedScenario: Scenario = {
  name:             "ls: 200 files, 45% with spaces (large scale)",
  description:      "대규모 디렉토리 — 200개 항목 중 90개 공백 포함 파일명. 정확도 55%. 역전 임계점 분석.",
  riskLevel:        "major",
  fixturePath:      "ls-200-mixed.txt",
  extractRaw:       extractRawLs,
  expectedNames:    expectedNames200,
  rawContextPrompt: RAW_CTX_LS,
  jsonContextPrompt: JSON_CTX_LS,
};
