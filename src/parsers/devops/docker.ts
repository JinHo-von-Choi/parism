export interface DockerPsEntry {
  container_id: string;
  image:        string;
  command:      string;
  created:      string;
  status:       string;
  ports:        string;
  names:        string;
}

export interface DockerStatsEntry {
  container_id: string;
  name:         string;
  cpu_perc:     string;
  mem_usage:    string;
  mem_limit:    string;
  mem_perc:     string;
  net_io:       string;
  block_io:     string;
  pids:         number | null;
}

function splitColumns(line: string): string[] {
  return line.trim().split(/\s{2,}/).map((v) => v.trim());
}

function parseDockerPs(raw: string): { resource: "ps"; containers: DockerPsEntry[] } {
  const lines = raw.split("\n").filter(Boolean);
  if (lines.length <= 1) return { resource: "ps", containers: [] };

  const containers: DockerPsEntry[] = [];

  for (const line of lines.slice(1)) {
    const cols = splitColumns(line);
    if (cols.length < 6) continue;

    containers.push({
      container_id: cols[0] ?? "",
      image:        cols[1] ?? "",
      command:      cols[2] ?? "",
      created:      cols[3] ?? "",
      status:       cols[4] ?? "",
      ports:        cols.length === 6 ? "" : (cols[5] ?? ""),
      names:        cols.length === 6 ? (cols[5] ?? "") : (cols[6] ?? ""),
    });
  }

  return { resource: "ps", containers };
}

function parseDockerStats(raw: string): { resource: "stats"; stats: DockerStatsEntry[] } {
  const lines = raw.split("\n").filter(Boolean);
  if (lines.length <= 1) return { resource: "stats", stats: [] };

  const stats: DockerStatsEntry[] = [];

  for (const line of lines.slice(1)) {
    const cols = splitColumns(line);
    if (cols.length < 7) continue;

    const memUsageParts = (cols[3] ?? "").split("/").map((v) => v.trim());

    stats.push({
      container_id: cols[0] ?? "",
      name:         cols[1] ?? "",
      cpu_perc:     cols[2] ?? "",
      mem_usage:    memUsageParts[0] ?? "",
      mem_limit:    memUsageParts[1] ?? "",
      mem_perc:     cols[4] ?? "",
      net_io:       cols[5] ?? "",
      block_io:     cols[6] ?? "",
      pids:         cols[7] ? (parseInt(cols[7], 10) || null) : null,
    });
  }

  return { resource: "stats", stats };
}

/**
 * docker 서브커맨드별 출력 파싱.
 * 현재 지원:
 * - docker ps
 * - docker stats --no-stream
 */
export function parseDocker(_cmd: string, args: string[], raw: string): unknown | null {
  const sub = args[0];

  if (sub === "ps")    return parseDockerPs(raw);
  if (sub === "stats") return parseDockerStats(raw);

  return null;
}
