import { UnrecognizedOutputError, type ParseContext } from "../registry.js";

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

export interface DockerImageEntry {
  repository: string;
  tag:        string;
  image_id:   string;
  created:    string;
  size:       string;
}

interface DockerImageSummary {
  total:     number;
  shown:     number;
  truncated: boolean;
}

const IMAGES_HEADER = /^REPOSITORY\s+TAG\s+IMAGE ID\s+CREATED\s+SIZE\s*$/;

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
      pids:         cols[7] !== undefined && /^\d+$/.test(cols[7]) ? parseInt(cols[7], 10) : null,
    });
  }

  return { resource: "stats", stats };
}

function parseDockerImages(
  raw: string,
  ctx?: ParseContext,
): { resource: "images"; images: DockerImageEntry[]; _summary?: DockerImageSummary } {
  const lines = raw.split("\n").filter(Boolean);
  if (lines.length === 0) return { resource: "images", images: [] };
  if (!IMAGES_HEADER.test(lines[0]!)) throw new UnrecognizedOutputError("docker images header was not recognized");
  if (lines.length === 1) return { resource: "images", images: [] };

  const images: DockerImageEntry[] = [];
  for (const line of lines.slice(1)) {
    const cols = splitColumns(line);
    if (cols.length !== 5) continue;

    images.push({
      repository: cols[0] ?? "",
      tag:        cols[1] ?? "",
      image_id:   cols[2] ?? "",
      created:    cols[3] ?? "",
      size:       cols[4] ?? "",
    });
  }

  const maxItems = ctx?.maxItems ?? 0;
  if (maxItems > 0 && images.length > maxItems) {
    return {
      resource: "images",
      images:   images.slice(0, maxItems),
      _summary: { total: images.length, shown: maxItems, truncated: true },
    };
  }
  return { resource: "images", images };
}

/**
 * docker 서브커맨드별 출력 파싱.
 * 현재 지원:
 * - docker ps
 * - docker images
 * - docker stats --no-stream
 */
export function parseDocker(_cmd: string, args: string[], raw: string, ctx?: ParseContext): unknown | null {
  const sub = args[0];

  if (sub === "ps")     return parseDockerPs(raw);
  if (sub === "images") return parseDockerImages(raw, ctx);
  if (sub === "stats")  return parseDockerStats(raw);

  return null;
}
