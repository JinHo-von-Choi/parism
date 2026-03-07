import type { Scenario, ExtractionResult } from "../types.js";

/**
 * raw kubectl get pods -o wide 출력에서 파드 목록 추출.
 * k8s 파드 이름은 DNS 규칙 준수 (공백 없음) → 공백 split 안전.
 * 단, STATUS가 "CrashLoopBackOff"처럼 긴 경우 컬럼 오프셋 이상 없음.
 */
function extractRawKubectl(raw: string): ExtractionResult {
  const start = Date.now();
  try {
    const lines = raw.split("\n").filter(Boolean);
    const dataLines = lines.filter(l => !l.startsWith("NAME"));
    const pods = dataLines.map(line => {
      const parts = line.trim().split(/\s+/);
      if (parts.length < 5) return null;
      return {
        name:     parts[0],
        ready:    parts[1],
        status:   parts[2],
        restarts: parseInt((parts[3] ?? "0").replace(/[^0-9]/g, ""), 10) || 0,
        age:      parts[4],
        ip:       parts[5] ?? null,
        node:     parts[6] ?? null,
      };
    }).filter(Boolean);
    return { success: true, data: pods, timeMs: Date.now() - start };
  } catch (e) {
    return { success: false, data: null, timeMs: Date.now() - start, errorMsg: String(e) };
  }
}

export const kubectlClusterScenario: Scenario = {
  name:        "kubectl: cluster scale (40 pods, -o wide)",
  description: "실제 k8s 클러스터 규모 — 40개 파드, 다양한 상태(Running/Pending/CrashLoopBackOff). DevOps 에이전트 시나리오.",
  riskLevel:   "major",

  fixturePath:  "kubectl-cluster.txt",
  extractRaw:   extractRawKubectl,
  parserArgs:   ["get", "pods"],

  rawContextPrompt: `kubectl get pods -o wide 출력을 파싱하세요.
컬럼: NAME READY STATUS RESTARTS AGE IP NODE
헤더(NAME으로 시작) 줄은 무시하세요.
STATUS가 "CrashLoopBackOff" 등 길 수 있음. RESTARTS는 숫자만 추출.
IP와 NODE는 Pending 상태면 <none>입니다.
각 파드의 name, ready, status, restarts, age, ip, node를 추출하세요.`,

  jsonContextPrompt: `stdout.parsed.pods 배열을 사용하세요.
각 항목: name, ready{current,total}, status, restarts, age, ip, node`,
};
