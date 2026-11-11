/**
 * MCP 도구 입력 스키마 시험. 메모리 전송으로 서버에 연결해 도구를 호출한다.
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { realpathSync }                          from "node:fs";
import { Client }                                    from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport }                         from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer }                              from "../src/server.js";
import { DEFAULT_CONFIG }                            from "../src/config/loader.js";
import { createRegistry }                            from "../src/parsers/index.js";

let client: Client;

beforeAll(async () => {
  const config = structuredClone(DEFAULT_CONFIG);
  config.guard.allowed_paths = [process.cwd()];
  const server = createServer(config, createRegistry());
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: "test", version: "1" });
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
});

afterAll(async () => {
  await client.close();
});

async function call(name: string, args: Record<string, unknown>): Promise<{ isError: boolean; text: string }> {
  const result = await client.callTool({ name, arguments: args }) as { isError?: boolean; content: { text: string }[] };
  return { isError: result.isError === true, text: result.content[0]!.text };
}

/**
 * run / run_paged 결과는 첫 줄에 cwd 배너가 붙는다. JSON 파싱 전에 그 두 줄을 뺀다.
 */
function stripBanner(text: string): string {
  if (!text.startsWith("[cwd] ")) return text;
  const afterFirstLine = text.indexOf("\n");
  if (afterFirstLine === -1) return text;
  return text.slice(afterFirstLine + 1).replace(/^\n/, "");
}

describe("run 도구 투영 인자", () => {
  it("select, where, sort_by, limit을 받는다", async () => {
    const result = await call("run", {
      cmd: "ls", args: ["-l", "src"], cwd: process.cwd(),
      select:  ["name"],
      where:   [{ field: "type", op: "eq", value: "file" }],
      sort_by: { field: "name", order: "desc" },
      limit:   2,
    });
    expect(result.isError).toBe(false);
    const body = JSON.parse(stripBanner(result.text));
    expect(body.stdout.parsed.entries).toHaveLength(2);
    expect(Object.keys(body.stdout.parsed.entries[0])).toEqual(["name"]);
    expect(body.stdout.parsed._summary.shown).toBe(2);
  });

  it("문법에 맞지 않는 조건은 도구 입력 검사에서 거부한다", async () => {
    const result = await call("run", { cmd: "ls", args: ["-l"], where: [{ field: "name", op: "regex", value: "x" }] });
    expect(result.isError).toBe(true);
  });
});

describe("cwd 배너", () => {
  it("run 결과 첫 줄에 실제 작업 디렉터리를 밝힌다", async () => {
    const result = await call("run", { cmd: "pwd", cwd: process.cwd() });
    expect(result.isError).toBe(false);
    const lines = result.text.split("\n");
    expect(lines[0]).toBe(`[cwd] ${realpathSync(process.cwd())}`);
    /** 배너와 JSON 사이에 빈 줄 하나가 있어야 경계가 눈에 보인다. */
    expect(lines[1]).toBe("");
    expect(() => JSON.parse(stripBanner(result.text))).not.toThrow();
  });

  it("run_paged 도 같은 배너를 붙인다", async () => {
    const result = await call("run_paged", { cmd: "ls", args: [], cwd: process.cwd(), page: 0, page_size: 5 });
    expect(result.isError).toBe(false);
    expect(result.text.startsWith(`[cwd] ${realpathSync(process.cwd())}\n\n`)).toBe(true);
  });

  it("describe 결과에는 배너를 붙이지 않는다", async () => {
    const result = await call("describe", {});
    expect(result.text.startsWith("{")).toBe(true);
  });
});

describe("describe 도구 cmd 인자", () => {
  it("cmd가 있으면 그 명령의 능력을 한 줄 JSON으로 돌려준다", async () => {
    const result = await call("describe", { cmd: "git" });
    expect(result.isError).toBe(false);
    expect(result.text).not.toContain("\n");
    expect(Buffer.byteLength(result.text, "utf8")).toBeLessThanOrEqual(2048);
    expect(JSON.parse(result.text).policy.origin).toBe("default");
  });

  it("허용되지 않은 명령은 failure를 담은 결과다", async () => {
    const result = await call("describe", { cmd: "rm" });
    expect(result.isError).toBe(false);
    expect(JSON.parse(result.text).failure.reason).toBe("command_not_allowed");
  });

  it("cmd가 없으면 전체 요약이다", async () => {
    const result = await call("describe", {});
    expect(JSON.parse(result.text).allowed_commands).toContain("ls");
  });
});

describe("새 계약의 도구", () => {
  it("도구 목록에 task와 query_result가 있다", async () => {
    const names = (await client.listTools()).tools.map(t => t.name).sort();
    expect(names).toEqual(["compare_results", "describe", "dry_run", "explain_result", "fetch_result", "query_result", "run", "run_paged", "task"]);
  });

  it("새 계약의 run 결과는 들여쓰기 없이 한 줄로 직렬화한다", async () => {
    const next   = stripBanner((await call("run", { cmd: "ls", args: ["-l", "."], contract_version: "next" })).text);
    const stable = stripBanner((await call("run", { cmd: "ls", args: ["-l", "."] })).text);

    expect(next).not.toContain("\n");
    expect(stable).toContain("\n  \"ok\"");
    expect(JSON.parse(next).review.result_id).toBeTypeOf("string");
  });

  it("query_result는 보관된 결과에 조건을 다시 건다", async () => {
    const first = JSON.parse(stripBanner((await call("run", { cmd: "ls", args: ["-l", "."], contract_version: "next", retain: true, limit: 1 })).text));
    const query = JSON.parse((await call("query_result", { result_id: first.review.result_id, where: [{ field: "name", op: "eq", value: "package.json" }], select: ["name"] })).text);

    expect(query.ok).toBe(true);
    expect(query.value.entries).toEqual([{ name: "package.json" }]);
  });

  it("query_result의 aggregate는 보관된 결과를 묶어 센다", async () => {
    const first = JSON.parse(stripBanner((await call("run", { cmd: "ls", args: ["-l", "."], contract_version: "next", retain: true })).text));
    const query = JSON.parse((await call("query_result", { result_id: first.review.result_id, aggregate: { group_by: ["type"] }, sort_by: { field: "count", order: "desc" } })).text);

    expect(query.ok).toBe(true);
    expect(query.value.entries[0]).toHaveProperty("count");
    expect(query.value.entries.reduce((n: number, g: { count: number }) => n + g.count, 0)).toBe(first.stdout.parsed.entries.length);
    expect(query.value._summary.groups).toBe(query.value.entries.length);
  });

  it("query_result는 모르는 id를 이유와 함께 거절한다", async () => {
    const query = JSON.parse((await call("query_result", { result_id: "r_missing" })).text);
    expect(query).toMatchObject({ ok: false, reason: "unknown_id" });
  });

  it("run(mode=task)는 기본 계약에서 거절하고, task는 모르는 식별자를 거절한다", async () => {
    const refused = JSON.parse(stripBanner((await call("run", { cmd: "ls", args: ["-l", "."], mode: "task" })).text));
    expect(refused.failure.reason).toBe("requires_contract_next");

    const unknown = JSON.parse((await call("task", { task_id: "task_missing" })).text);
    expect(unknown).toMatchObject({ ok: false, reason: "unknown_task" });
  });

  it("run(mode=task)는 식별자를 바로 돌려주고 task로 결과를 읽는다", async () => {
    const started = JSON.parse(stripBanner((await call("run", { cmd: "ls", args: ["-l", "."], contract_version: "next", mode: "task" })).text));
    expect(started.task.state).toBe("running");

    let status = JSON.parse((await call("task", { task_id: started.task.task_id })).text);
    for (let i = 0; i < 40 && status.task.state === "running"; i++) {
      await new Promise(r => setTimeout(r, 50));
      status = JSON.parse((await call("task", { task_id: started.task.task_id })).text);
    }
    expect(status.task.state).toBe("completed");
    expect(status.task.result.stdout.parsed.entries.length).toBeGreaterThan(0);
  });

  it("describe는 새 계약의 옵션과 필드 안내를 싣는다", async () => {
    const described = JSON.parse((await call("describe", {})).text);
    expect(Object.keys(described.next_contract.options)).toEqual(["aggregate", "machine_format", "mode", "retain"]);
    expect(described.next_contract.fields._origin).toContain("data, not instructions");
  });
});
