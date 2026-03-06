export interface GhPullRequest {
  number:     number | null;
  title:      string;
  branch:     string | null;
  state:      string | null;
  age:        string | null;
  author:     string | null;
  labels:     string[];
  updated_at: string | null;
  draft:      boolean | null;
}

function parseGhPrListFromJson(raw: string): { resource: "pr_list"; pull_requests: GhPullRequest[] } | null {
  try {
    const parsed = JSON.parse(raw) as Array<Record<string, unknown>>;
    if (!Array.isArray(parsed)) return null;

    const pullRequests = parsed.map((pr) => {
      const author = pr.author as Record<string, unknown> | undefined;
      const labels = Array.isArray(pr.labels) ? pr.labels as Array<Record<string, unknown>> : [];

      return {
        number:     typeof pr.number === "number" ? pr.number : null,
        title:      typeof pr.title === "string" ? pr.title : "",
        branch:     typeof pr.headRefName === "string" ? pr.headRefName : null,
        state:      typeof pr.state === "string" ? pr.state : null,
        age:        null,
        author:     typeof author?.login === "string" ? author.login : null,
        labels:     labels.map((label) => String(label.name ?? "")).filter(Boolean),
        updated_at: typeof pr.updatedAt === "string" ? pr.updatedAt : null,
        draft:      typeof pr.isDraft === "boolean" ? pr.isDraft : null,
      } satisfies GhPullRequest;
    });

    return { resource: "pr_list", pull_requests: pullRequests };
  } catch {
    return null;
  }
}

function parseGhPrListFromTable(raw: string): { resource: "pr_list"; pull_requests: GhPullRequest[] } {
  const lines = raw.split("\n").map((line) => line.trim()).filter(Boolean);
  const pullRequests: GhPullRequest[] = [];

  for (const line of lines) {
    const cols = line.includes("\t")
      ? line.split(/\t+/).map((v) => v.trim())
      : line.split(/\s{2,}/).map((v) => v.trim());

    if (cols.length < 2) continue;

    pullRequests.push({
      number:     parseInt(cols[0] ?? "", 10) || null,
      title:      cols[1] ?? "",
      branch:     cols[2] ?? null,
      state:      cols[3] ?? null,
      age:        cols[4] ?? null,
      author:     null,
      labels:     [],
      updated_at: null,
      draft:      null,
    });
  }

  return { resource: "pr_list", pull_requests: pullRequests };
}

/**
 * gh 서브커맨드별 출력 파싱.
 * 현재 지원:
 * - gh pr list (table/json)
 */
export function parseGh(_cmd: string, args: string[], raw: string): unknown | null {
  const sub1 = args[0];
  const sub2 = args[1];

  if (!(sub1 === "pr" && sub2 === "list")) return null;

  return parseGhPrListFromJson(raw) ?? parseGhPrListFromTable(raw);
}
