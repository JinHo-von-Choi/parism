import type { Scenario, ExtractionResult } from "../types.js";

/**
 * raw docker ps 출력에서 컨테이너 목록 추출.
 * docker ps는 2개 이상 공백으로 컬럼을 구분. 단일 공백으로 split하면 오동작.
 * 2+ 공백 기준 split은 COMMAND 필드의 따옴표 포함 공백도 올바르게 처리.
 * PORTS 컬럼은 비어있을 수 있음 (포트 매핑 없는 컨테이너).
 */
function extractRawDocker(raw: string): ExtractionResult {
  const start = Date.now();
  try {
    const lines = raw.split("\n").filter(Boolean);
    const dataLines = lines.filter(l => !l.startsWith("CONTAINER"));
    const containers = dataLines.map(line => {
      // docker ps는 2+ 공백으로 컬럼 구분 — 단순 \s+ split은 COMMAND 내부 공백에서 깨짐
      const cols = line.trim().split(/\s{2,}/);
      if (cols.length < 6) return null;
      return {
        container_id: cols[0],
        image:        cols[1],
        command:      cols[2],
        created:      cols[3],
        status:       cols[4],
        // PORTS 컬럼 없는 컨테이너: cols[5]가 NAMES
        ports: cols.length === 6 ? "" : (cols[5] ?? ""),
        names: cols.length === 6 ? (cols[5] ?? "") : (cols[6] ?? ""),
      };
    }).filter(Boolean);
    return { success: true, data: containers, timeMs: Date.now() - start };
  } catch (e) {
    return { success: false, data: null, timeMs: Date.now() - start, errorMsg: String(e) };
  }
}

export const dockerFleetScenario: Scenario = {
  name:        "docker: production fleet (25 containers)",
  description: "실제 마이크로서비스 플리트 — 25개 컨테이너, 복잡한 포트 매핑. docker ps 2+ 공백 컬럼 구분 특수성.",
  riskLevel:   "major",

  fixturePath:  "docker-fleet.txt",
  extractRaw:   extractRawDocker,
  parserArgs:   ["ps"],

  rawContextPrompt: `docker ps 출력을 파싱하세요.
컬럼: CONTAINER ID, IMAGE, COMMAND, CREATED, STATUS, PORTS, NAMES
중요: docker ps는 컬럼 구분에 2개 이상 공백 사용. 단일 공백으로 split하면 COMMAND와 PORTS가 깨짐.
PORTS는 "0.0.0.0:80->80/tcp, 0.0.0.0:443->443/tcp" 형태로 쉼표 포함 가능.
포트 매핑 없는 컨테이너는 PORTS 컬럼이 비어있음.
각 컨테이너의 id, image, status, ports, name을 추출하세요.`,

  jsonContextPrompt: `stdout.parsed.containers 배열을 사용하세요.
각 항목: container_id, image, command, created, status, ports, names`,
};
