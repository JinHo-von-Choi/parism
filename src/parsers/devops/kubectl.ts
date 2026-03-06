export interface KubectlPodEntry {
  name:      string;
  ready:     { current: number; total: number } | null;
  status:    string;
  restarts:  number;
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

    pods.push({
      name:     cols[0] ?? "",
      ready:    parseReady(cols[1] ?? ""),
      status:   cols[2] ?? "",
      restarts: parseInt((cols[3] ?? "0").replace(/[^0-9]/g, ""), 10) || 0,
      age:      cols[4] ?? "",
      ip:       cols[5] ?? null,
      node:     cols[6] ?? null,
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
