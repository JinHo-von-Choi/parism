export interface KubectlPodEntry {
  name:      string;
  ready:     { current: number; total: number } | null;
  status:    string;
  restarts:  number;
  /** 재시작 횟수가 0이 아닐 때 kubectl 이 RESTARTS 뒤에 붙이는 괄호 표기("2 (5d ago)") */
  lastRestart: string | null;
  age:       string;
  ip:        string | null;
  node:      string | null;
}

export interface KubectlEventEntry {
  last_seen: string;
  type:      string;
  reason:    string;
  object:    string;
  message:   string;
}

function parseReady(value: string): { current: number; total: number } | null {
  const match = value.match(/^(\d+)\/(\d+)$/);
  if (!match) return null;

  return {
    current: parseInt(match[1], 10),
    total:   parseInt(match[2], 10),
  };
}

function parseKubectlPods(raw: string): { resource: "pods"; pods: KubectlPodEntry[] } {
  const lines = raw.split("\n").map((line) => line.trim()).filter(Boolean);
  if (lines.length <= 1) return { resource: "pods", pods: [] };

  const pods: KubectlPodEntry[] = [];

  for (const line of lines.slice(1)) {
    const cols = line.split(/\s+/);
    if (cols.length < 5) continue;

    /**
     * RESTARTS 가 0 이 아니면 kubectl 이 그 뒤에 "(5d ago)" 처럼 괄호 표기를 붙인다.
     * 이 표기를 열 하나로 세면 이후 열이 한 칸씩 밀려 AGE 에 "(5d" 가 들어가고
     * 나머지 값이 IP 와 NODE 로 잘못 읽힌다. 닫는 괄호까지를 RESTARTS 값으로 묶고 그 다음 칸을 AGE 로 본다.
     */
    let ageCol = 4;
    let lastRestart: string | null = null;
    if (cols[ageCol]?.startsWith("(")) {
      let j = ageCol;
      while (j < cols.length && !cols[j]!.includes(")")) j++;
      if (j < cols.length) {
        lastRestart = cols.slice(ageCol, j + 1).join(" ");
        ageCol = j + 1;
      }
    }

    pods.push({
      name:        cols[0] ?? "",
      ready:       parseReady(cols[1] ?? ""),
      status:      cols[2] ?? "",
      restarts:    parseInt((cols[3] ?? "0").replace(/[^0-9]/g, ""), 10) || 0,
      lastRestart,
      age:         cols[ageCol] ?? "",
      ip:          cols[ageCol + 1] ?? null,
      node:        cols[ageCol + 2] ?? null,
    });
  }

  return { resource: "pods", pods };
}

function parseKubectlEvents(raw: string): { resource: "events"; events: KubectlEventEntry[] } {
  const lines = raw.split("\n").map((line) => line.trim()).filter(Boolean);
  if (lines.length <= 1) return { resource: "events", events: [] };

  const events: KubectlEventEntry[] = [];

  for (const line of lines.slice(1)) {
    const cols = line.split(/\s+/);
    if (cols.length < 5) continue;

    const [lastSeen, type, reason, object, ...messageParts] = cols;
    events.push({
      last_seen: lastSeen ?? "",
      type:      type ?? "",
      reason:    reason ?? "",
      object:    object ?? "",
      message:   messageParts.join(" "),
    });
  }

  return { resource: "events", events };
}

/**
 * kubectl 서브커맨드별 출력 파싱.
 * 현재 지원:
 * - kubectl get pods
 * - kubectl get events
 */
export function parseKubectl(_cmd: string, args: string[], raw: string): unknown | null {
  const sub      = args[0];
  const resource = args[1];

  if (sub !== "get") return null;
  if (resource === "pods")   return parseKubectlPods(raw);
  if (resource === "events") return parseKubectlEvents(raw);

  return null;
}
