import type { Scenario, ExtractionResult } from "../types.js";

/**
 * Linux netstat 출력에서 연결 정보 추출.
 * Linux는 "address:port" 형식 사용.
 */
function extractRawNetstatLinux(raw: string): ExtractionResult {
  const start = Date.now();
  try {
    const lines = raw.split("\n").filter(Boolean);
    // Skip header lines (start with "Active" or "Proto")
    const dataLines = lines.filter(l => !l.startsWith("Active") && !l.startsWith("Proto"));

    const connections = dataLines.map(line => {
      const parts = line.trim().split(/\s+/);
      // Linux: Proto Recv-Q Send-Q LocalAddr ForeignAddr State(optional)
      const proto   = parts[0];
      const local   = parts[3];
      const foreign = parts[4];
      const state   = parts[5] ?? "";

      // Split address:port — Linux uses colon
      const localParts   = local?.lastIndexOf(":") ?? -1;
      const foreignParts = foreign?.lastIndexOf(":") ?? -1;

      return {
        proto,
        local_address:   local?.slice(0, localParts > 0 ? localParts : undefined),
        local_port:      local?.slice(localParts + 1),
        foreign_address: foreign?.slice(0, foreignParts > 0 ? foreignParts : undefined),
        state,
      };
    });

    return { success: true, data: connections, timeMs: Date.now() - start };
  } catch (e) {
    return { success: false, data: null, timeMs: Date.now() - start, errorMsg: String(e) };
  }
}

/**
 * macOS netstat 출력 파싱 — macOS는 dot(.) 구분자 사용.
 * Linux 파서(콜론 기준 분리)를 그대로 쓰면 포트 추출이 항상 틀린다.
 */
function extractRawNetstatMacos(raw: string): ExtractionResult {
  const start = Date.now();
  try {
    const lines = raw.split("\n").filter(Boolean);
    const dataLines = lines.filter(l => !l.startsWith("Active") && !l.startsWith("Proto"));

    const connections = dataLines.map(line => {
      const parts = line.trim().split(/\s+/);
      const proto   = parts[0];
      const local   = parts[3];
      const foreign = parts[4];
      const state   = parts[5] ?? "";

      // BUG: using colon split on macOS dot-separated address — port extraction fails
      // "127.0.0.1.5432" split by last ":" → returns full string as address, no port
      const colonIdx = local?.lastIndexOf(":") ?? -1;
      const port = colonIdx >= 0 ? local?.slice(colonIdx + 1) : "PARSE_ERROR";

      return {
        proto,
        local_raw:  local,  // shows raw value to demonstrate the parsing error
        local_port: port,   // will be wrong for macOS format
        state,
      };
    });

    // Mark as success but data is semantically wrong (port extraction failed)
    return { success: true, data: connections, timeMs: Date.now() - start };
  } catch (e) {
    return { success: false, data: null, timeMs: Date.now() - start, errorMsg: String(e) };
  }
}

export const netstatLinuxScenario: Scenario = {
  name:        "netstat: Linux format",
  description: "네트워크 연결 목록 추출 (Linux — address:port 콜론 구분)",
  riskLevel:   "minor",
  fixturePath: "netstat-linux.txt",
  extractRaw:  extractRawNetstatLinux,

  rawContextPrompt: `netstat 출력을 파싱하세요 (Linux 형식).
컬럼: Proto Recv-Q Send-Q LocalAddress ForeignAddress State
주소 형식: IP:포트 (콜론 구분), 예: 127.0.0.1:5432
헤더(Active, Proto로 시작) 줄은 무시하세요.
각 연결의 proto, 로컬주소, 로컬포트, 원격주소, 상태를 추출하세요.`,

  jsonContextPrompt: `stdout.parsed.connections 배열을 사용하세요.
각 항목: proto, local_address, local_port, foreign_address, foreign_port, state`,
};

export const netstatMacosScenario: Scenario = {
  name:        "netstat: macOS format (address separator edge case)",
  description: "macOS는 IP.포트 점(.) 구분 — Linux 파서 적용 시 포트 추출 완전 오동작",
  riskLevel:   "minor",
  fixturePath: "netstat-macos.txt",
  extractRaw:  extractRawNetstatMacos,  // semantically wrong output

  rawContextPrompt: `netstat 출력을 파싱하세요.
주의: 이 출력은 macOS 형식입니다.
macOS는 IP.포트 형식 사용 (점 구분), 예: 127.0.0.1.5432
Linux의 콜론(:) 기준 파서를 그대로 적용하면 포트를 추출할 수 없습니다.
macOS에서 포트는 마지막 점(.) 이후 값입니다.
각 연결의 proto, 로컬 포트, 상태를 추출하세요.`,

  jsonContextPrompt: `stdout.parsed.connections 배열을 사용하세요.
Parism은 OS 무관하게 동일 구조: proto, local_address, local_port, foreign_address, foreign_port, state`,
};
