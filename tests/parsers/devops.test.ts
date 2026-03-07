import { describe, it, expect } from "vitest";
import { parseKubectl }   from "../../src/parsers/devops/kubectl.js";
import { parseDocker }   from "../../src/parsers/devops/docker.js";
import { parseGh }       from "../../src/parsers/devops/gh.js";
import { parseHelm }     from "../../src/parsers/devops/helm.js";
import { parseTerraform } from "../../src/parsers/devops/terraform.js";

describe("parseKubectl()", () => {
  it("kubectl get events 출력을 파싱한다", () => {
    const raw = [
      "LAST SEEN   TYPE     REASON   OBJECT                    MESSAGE",
      "2m          Normal   Scheduled  pod/api-abc   Successfully assigned",
      "1m          Warning  Failed     pod/worker-xyz   Error pulling image",
    ].join("\n");

    const result = parseKubectl("kubectl", ["get", "events"], raw) as {
      resource: string;
      events: Array<{ type: string; reason: string; message: string }>;
    };

    expect(result.resource).toBe("events");
    expect(result.events).toHaveLength(2);
    expect(result.events[0]?.type).toBe("Normal");
    expect(result.events[0]?.reason).toBe("Scheduled");
    expect(result.events[1]?.reason).toBe("Failed");
  });

  it("kubectl get 외 서브커맨드는 null", () => {
    expect(parseKubectl("kubectl", ["apply", "-f", "x.yaml"], "")).toBeNull();
  });

  it("kubectl get pods/events 외 리소스는 null", () => {
    expect(parseKubectl("kubectl", ["get", "services"], "NAME TYPE")).toBeNull();
  });

  it("parseReady가 1/1 형식이 아닐 때 null", () => {
    const raw = [
      "NAME       READY   STATUS    RESTARTS   AGE",
      "pod-abc    Unknown  Running   0          1d",
    ].join("\n");
    const result = parseKubectl("kubectl", ["get", "pods"], raw) as {
      resource: string;
      pods: Array<{ ready: { current: number; total: number } | null }>;
    };
    expect(result.pods[0]?.ready).toBeNull();
  });

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

  it("kubectl get pods 5컬럼(ip/node 없음) 행", () => {
    const raw = [
      "NAME       READY   STATUS    RESTARTS   AGE",
      "pod-minimal 1/1     Running   0          10m",
    ].join("\n");
    const result = parseKubectl("kubectl", ["get", "pods"], raw) as {
      resource: string;
      pods: Array<{ ip: string | null; node: string | null }>;
    };
    expect(result.pods[0]?.ip).toBeNull();
    expect(result.pods[0]?.node).toBeNull();
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

  it("docker ps/stats 외 서브커맨드는 null", () => {
    expect(parseDocker("docker", ["images"], "REPOSITORY TAG")).toBeNull();
    expect(parseDocker("docker", ["inspect", "abc"], "[]")).toBeNull();
  });

  it("docker ps 7컬럼(ports 있음) 행을 파싱한다", () => {
    const raw = [
      "CONTAINER ID   IMAGE     COMMAND   CREATED   STATUS   PORTS         NAMES",
      "abc123         nginx     \"nginx\"   1 hour    Up       0.0.0.0:80->80/tcp   web",
    ].join("\n");
    const result = parseDocker("docker", ["ps"], raw) as { resource: string; containers: Array<{ ports: string; names: string }> };
    expect(result.containers[0]?.ports).toBe("0.0.0.0:80->80/tcp");
    expect(result.containers[0]?.names).toBe("web");
  });

  it("docker ps 6컬럼(ports 없음) 행을 파싱한다", () => {
    const raw = [
      "CONTAINER ID   IMAGE     COMMAND   CREATED   STATUS   NAMES",
      "abc123         nginx     \"nginx\"   1 hour    Up       web",
    ].join("\n");
    const result = parseDocker("docker", ["ps"], raw) as { resource: string; containers: Array<{ ports: string; names: string }> };
    expect(result.containers[0]?.ports).toBe("");
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

  it("docker stats pids 컬럼 없을 때 null", () => {
    const raw = [
      "CONTAINER ID   NAME   CPU %   MEM USAGE / LIMIT   MEM %   NET I/O   BLOCK I/O",
      "abc123         web    0.5%    10MiB / 512MiB      2%      1kB/2kB   0B/0B",
    ].join("\n");
    const result = parseDocker("docker", ["stats", "--no-stream"], raw) as {
      resource: string;
      stats: Array<{ pids: number | null }>;
    };
    expect(result.stats[0]?.pids).toBeNull();
  });
});

describe("parseGh()", () => {
  it("pr list 외 서브커맨드는 null 반환", () => {
    expect(parseGh("gh", ["repo", "list"], "[]")).toBeNull();
    expect(parseGh("gh", ["issues"], "[]")).toBeNull();
  });

  it("gh pr list JSON이 배열이 아니면 테이블 폴백", () => {
    const result = parseGh("gh", ["pr", "list"], '{"not":"array"}') as {
      resource: string;
      pull_requests: unknown[];
    };
    expect(result.resource).toBe("pr_list");
    expect(result.pull_requests).toEqual([]);
  });

  it("gh pr list 테이블 형식을 파싱한다", () => {
    const raw = "12\tfeat: add parser\tfeat/parser\tOPEN\tnirna";
    const result = parseGh("gh", ["pr", "list"], raw) as { resource: string; pull_requests: Array<{ number: number | null; title: string }> };
    expect(result.resource).toBe("pr_list");
    expect(result.pull_requests[0]?.number).toBe(12);
    expect(result.pull_requests[0]?.title).toBe("feat: add parser");
  });

  it("gh pr list JSON 파싱 실패 시 테이블 폴백", () => {
    const result = parseGh("gh", ["pr", "list"], "12\tfeat\tfeat/br\tOPEN") as {
      resource: string;
      pull_requests: Array<{ number: number | null }>;
    };
    expect(result.resource).toBe("pr_list");
    expect(result.pull_requests[0]?.number).toBe(12);
  });

  it("gh pr list 테이블(공백 2개 이상 구분) 파싱", () => {
    const result = parseGh("gh", ["pr", "list"], "12   feature title   OPEN") as {
      resource: string;
      pull_requests: Array<{ number: number | null; title: string }>;
    };
    expect(result.pull_requests[0]?.number).toBe(12);
    expect(result.pull_requests[0]?.title).toBe("feature title");
  });

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

describe("parseHelm()", () => {
  const raw = [
    "NAME	NAMESPACE	REVISION	UPDATED	STATUS	CHART	APP VERSION",
    "ingress-nginx	ingress-nginx	5	2026-02-15 10:00:00	deployed	ingress-nginx-4.10.0	1.10.0",
    "cert-manager	cert-manager	3	2026-02-10 09:00:00	deployed	cert-manager-v1.14.0	v1.14.0",
  ].join("\n");

  it("helm 빈 출력 시 releases: []", () => {
    const result = parseHelm("helm", [], "") as { releases: unknown[] };
    expect(result.releases).toEqual([]);
  });

  it("helm list 출력을 파싱한다", () => {
    const result = parseHelm("helm", ["list", "-A"], raw) as { releases: Array<{ name: string; namespace: string; status: string; chart: string }> };
    expect(result.releases).toHaveLength(2);
    expect(result.releases[0]?.name).toBe("ingress-nginx");
    expect(result.releases[0]?.namespace).toBe("ingress-nginx");
    expect(result.releases[0]?.status).toBe("deployed");
    expect(result.releases[0]?.chart).toBe("ingress-nginx-4.10.0");
  });

  it("helm maxItems 초과 시 truncation", () => {
    const many = Array.from({ length: 10 }, (_, i) =>
      `rel${i}\tns${i}\t1\t2026-01-01\tdeployed\tchart\t1.0`,
    ).join("\n");
    const full = "NAME\tNAMESPACE\tREVISION\tUPDATED\tSTATUS\tCHART\tAPP VERSION\n" + many;
    const result = parseHelm("helm", ["list"], full, { maxItems: 3, format: "json" }) as { releases: unknown[] };
    expect(result.releases).toHaveLength(3);
  });

  it("헤더 없으면 { lines } 폴백", () => {
    const result = parseHelm("helm", [], "line1\nline2") as { lines: string[] };
    expect(result.lines).toEqual(["line1", "line2"]);
  });
});

describe("parseTerraform()", () => {
  const raw = [
    "Terraform will perform the following actions:",
    "  # aws_instance.web will be created",
    "Plan: 2 to add, 0 to change, 1 to destroy.",
  ].join("\n");

  it("terraform plan 출력에서 Plan 요약을 파싱한다", () => {
    const result = parseTerraform("terraform", ["plan"], raw) as { summary: { to_add: number; to_change: number; to_destroy: number } };
    expect(result.summary.to_add).toBe(2);
    expect(result.summary.to_change).toBe(0);
    expect(result.summary.to_destroy).toBe(1);
  });

  it("Plan 라인 없으면 { lines } 폴백", () => {
    const result = parseTerraform("terraform", [], "no plan line\nhere") as { lines: string[] };
    expect(result.lines).toEqual(["no plan line", "here"]);
  });

  it("빈 출력 시 { lines: [] }", () => {
    const result = parseTerraform("terraform", [], "") as { lines: string[] };
    expect(result.lines).toEqual([]);
  });
});
