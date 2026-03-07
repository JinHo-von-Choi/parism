import type { Scenario, ExtractionResult } from "../types.js";

function extractRawDfLinux(raw: string): ExtractionResult {
  const start = Date.now();
  try {
    const lines = raw.split("\n").filter(Boolean);
    const header = lines[0] ?? "";
    if (!header.includes("Filesystem")) throw new Error("unexpected header");
    const entries = lines.slice(1).map(line => {
      const parts = line.trim().split(/\s+/);
      return {
        filesystem:  parts[0],
        size:        parts[1],
        used:        parts[2],
        available:   parts[3],
        use_percent: parts[4],
        mounted_on:  parts[5],
      };
    });
    return { success: true, data: entries, timeMs: Date.now() - start };
  } catch (e) {
    return { success: false, data: null, timeMs: Date.now() - start, errorMsg: String(e) };
  }
}

function extractRawDfMacos(raw: string): ExtractionResult {
  const start = Date.now();
  try {
    const lines = raw.split("\n").filter(Boolean);
    const header = lines[0] ?? "";
    // macOS: Filesystem 1024-blocks Used Available Capacity Mounted on
    // A naive Linux parser reading macOS output gets Use% from wrong column
    if (!header.includes("1024-blocks")) {
      // Simulating the error: Linux parser applied to macOS output
      // use_percent will be from index 4 but that's "Available" in macOS, not "Capacity"
    }
    const entries = lines.slice(1).map(line => {
      const parts = line.trim().split(/\s+/);
      // Wrong: treating index 4 as use_percent (it's "Capacity" in macOS, "Use%" in Linux)
      // A naive single parser gets wrong values for macOS
      return {
        filesystem:  parts[0],
        use_percent: parts[4],  // macOS: Capacity, Linux: Use% — same index, different meaning
        mounted_on:  parts[5],
      };
    });
    return { success: true, data: entries, timeMs: Date.now() - start };
  } catch (e) {
    return { success: false, data: null, timeMs: Date.now() - start, errorMsg: String(e) };
  }
}

export const dfLinuxScenario: Scenario = {
  name:        "df -h: Linux",
  description: "디스크 사용량 추출 (Linux 형식)",
  riskLevel:   "minor",
  fixturePath: "df-h.txt",
  extractRaw:  extractRawDfLinux,

  rawContextPrompt: `df -h 출력을 파싱하세요.
Linux 형식 컬럼: Filesystem Size Used Avail Use% Mounted on
각 파티션의 Use%(사용률)와 Mounted on(마운트 경로)을 추출하세요.`,

  jsonContextPrompt: `stdout.parsed.filesystems 배열을 사용하세요.
각 항목: filesystem, size, used, available, use_percent, mounted_on`,
};

export const dfMacosScenario: Scenario = {
  name:        "df: macOS (OS format edge case)",
  description: "macOS df 헤더('1024-blocks')가 달라 raw 파싱 로직이 달라야 함. 단일 파서로는 혼동 유발.",
  riskLevel:   "minor",
  fixturePath: "df-macos.txt",
  extractRaw:  extractRawDfMacos,

  rawContextPrompt: `df 출력을 파싱하세요.
macOS 형식 컬럼: Filesystem 1024-blocks Used Available Capacity Mounted on
Capacity 컬럼(인덱스 4)이 사용률(%)입니다.
Linux의 Use% 위치(인덱스 4)와 이름은 같지만 단위와 의미가 다릅니다.
파티션별 Capacity와 Mounted on을 추출하세요.`,

  jsonContextPrompt: `stdout.parsed.filesystems 배열을 사용하세요.
각 항목: filesystem, use_percent, mounted_on (OS 무관하게 동일 구조)`,
};
