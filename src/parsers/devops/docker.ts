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
  repository:   string;
  tag:          string | null;
  image_id:     string;
  digest:       string | null;
  created:      string | null;
  size:         string;
  content_size: string | null;
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
      pids:         cols[7] !== undefined && /^\d+$/.test(cols[7]) ? parseInt(cols[7], 10) : null,
    });
  }

  return { resource: "stats", stats };
}

function splitImageReference(image: string): { repository: string; tag: string | null } {
  const slash = image.lastIndexOf("/");
  const colon = image.lastIndexOf(":");
  if (colon <= slash || image.includes("@")) return { repository: image, tag: null };
  return { repository: image.slice(0, colon), tag: image.slice(colon + 1) };
}

function parseDockerImages(raw: string): { resource: "images"; images: DockerImageEntry[] } {
  const lines = raw.split(/\r?\n/).filter((line) => line.trim());
  if (lines.length === 0) return { resource: "images", images: [] };

  const headings = splitColumns(lines[0]!).map((heading) => heading.toUpperCase());
  const column = (name: string): number => headings.indexOf(name);
  const repositoryColumn = column("REPOSITORY");
  const imageColumn      = column("IMAGE");
  const imageIdColumn    = column("IMAGE ID") >= 0 ? column("IMAGE ID") : column("ID");
  const tagColumn        = column("TAG");
  const digestColumn     = column("DIGEST");
  const createdColumn    = column("CREATED");
  const sizeColumn       = column("SIZE") >= 0 ? column("SIZE") : column("DISK USAGE");
  const contentColumn    = column("CONTENT SIZE");
  const recognizedHeader = imageIdColumn >= 0 && sizeColumn >= 0 && (repositoryColumn >= 0 || imageColumn >= 0);
  if (!recognizedHeader) return { resource: "images", images: [] };

  const images: DockerImageEntry[] = [];
  for (const line of lines.slice(1)) {
    const cols = splitColumns(line);
    const reference = repositoryColumn >= 0 ? cols[repositoryColumn] : cols[imageColumn];
    const imageId   = cols[imageIdColumn];
    const size      = cols[sizeColumn];
    if (!reference || !imageId || !size) continue;

    const split = repositoryColumn >= 0
      ? { repository: reference, tag: tagColumn >= 0 ? (cols[tagColumn] ?? null) : null }
      : splitImageReference(reference);
    images.push({
      ...split,
      image_id:     imageId,
      digest:       digestColumn >= 0 ? (cols[digestColumn] ?? null) : null,
      created:      createdColumn >= 0 ? (cols[createdColumn] ?? null) : null,
      size,
      content_size: contentColumn >= 0 ? (cols[contentColumn] ?? null) : null,
    });
  }

  return { resource: "images", images };
}

/**
 * docker 서브커맨드별 출력 파싱.
 * 현재 지원:
 * - docker ps
 * - docker stats --no-stream
 * - docker images
 */
export function parseDocker(_cmd: string, args: string[], raw: string): unknown | null {
  const sub = args[0];

  if (sub === "ps")    return parseDockerPs(raw);
  if (sub === "stats") return parseDockerStats(raw);
  if (sub === "images") return parseDockerImages(raw);

  return null;
}
