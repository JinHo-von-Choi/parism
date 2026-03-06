import { describe, it, expect } from "vitest";
import { parseKubectl } from "../../src/parsers/devops/kubectl.js";
import { parseDocker }  from "../../src/parsers/devops/docker.js";
import { parseGh }      from "../../src/parsers/devops/gh.js";

describe("parseKubectl()", () => {
  it("kubectl get pods 출력을 파싱한다", () => {
    const raw = [
      "NAME                          READY   STATUS    RESTARTS   AGE   IP           NODE",
      "api-7b6b6f9d8f-abcde          1/1     Running   0          2d    10.0.1.10    node-a",
      "worker-5f9d8c77cb-xyz12       0/1     Pending   3          1h    <none>       node-b",
    ].join("\n");

    const result = parseKubectl("kubectl", ["get", "pods"], raw) as {
      resource: string;
      pods: Array<{
        name: string;
        ready: { current: number; total: number } | null;
        status: string;
        restarts: number;
      }>;
    };

    expect(result.resource).toBe("pods");
    expect(result.pods[0]?.name).toBe("api-7b6b6f9d8f-abcde");
    expect(result.pods[0]?.ready).toEqual({ current: 1, total: 1 });
    expect(result.pods[1]?.status).toBe("Pending");
    expect(result.pods[1]?.restarts).toBe(3);
  });
});

describe("parseDocker()", () => {
  it("docker ps 출력을 파싱한다", () => {
    const raw = [
      "CONTAINER ID   IMAGE          COMMAND                  CREATED         STATUS         PORTS                    NAMES",
      "abc123def456   nginx:1.27    \"nginx -g 'daemon o\"   2 hours ago     Up 2 hours     0.0.0.0:80->80/tcp       web",
    ].join("\n");

    const result = parseDocker("docker", ["ps"], raw) as {
      resource: string;
      containers: Array<{ image: string; names: string }>;
    };

    expect(result.resource).toBe("ps");
    expect(result.containers[0]?.image).toBe("nginx:1.27");
    expect(result.containers[0]?.names).toBe("web");
  });

  it("docker stats 출력을 파싱한다", () => {
    const raw = [
      "CONTAINER ID   NAME   CPU %   MEM USAGE / LIMIT   MEM %   NET I/O      BLOCK I/O   PIDS",
      "abc123def456   web    1.23%   25MiB / 512MiB       4.88%   10kB / 2kB   0B / 0B    12",
    ].join("\n");

    const result = parseDocker("docker", ["stats", "--no-stream"], raw) as {
      resource: string;
      stats: Array<{ cpu_perc: string; mem_usage: string; mem_limit: string; pids: number | null }>;
    };

    expect(result.resource).toBe("stats");
    expect(result.stats[0]?.cpu_perc).toBe("1.23%");
    expect(result.stats[0]?.mem_usage).toBe("25MiB");
    expect(result.stats[0]?.mem_limit).toBe("512MiB");
    expect(result.stats[0]?.pids).toBe(12);
  });
});

describe("parseGh()", () => {
  it("gh pr list --json 출력을 파싱한다", () => {
    const raw = JSON.stringify([
      {
        number: 12,
        title: "feat: add parser",
        state: "OPEN",
        headRefName: "feat/parser",
        updatedAt: "2026-03-06T10:00:00Z",
        isDraft: false,
        author: { login: "nirna" },
        labels: [{ name: "enhancement" }],
      },
    ]);

    const result = parseGh("gh", ["pr", "list", "--json", "number,title"], raw) as {
      resource: string;
      pull_requests: Array<{ number: number | null; author: string | null; labels: string[] }>;
    };

    expect(result.resource).toBe("pr_list");
    expect(result.pull_requests[0]?.number).toBe(12);
    expect(result.pull_requests[0]?.author).toBe("nirna");
    expect(result.pull_requests[0]?.labels).toEqual(["enhancement"]);
  });
});
