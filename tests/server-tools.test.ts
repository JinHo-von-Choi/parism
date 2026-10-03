/**
 * MCP 도구 입력 스키마 시험. 메모리 전송으로 서버에 연결해 도구를 호출한다.
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
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
    const body = JSON.parse(result.text);
    expect(body.stdout.parsed.entries).toHaveLength(2);
    expect(Object.keys(body.stdout.parsed.entries[0])).toEqual(["name"]);
    expect(body.stdout.parsed._summary.shown).toBe(2);
  });

  it("문법에 맞지 않는 조건은 도구 입력 검사에서 거부한다", async () => {
    const result = await call("run", { cmd: "ls", args: ["-l"], where: [{ field: "name", op: "regex", value: "x" }] });
    expect(result.isError).toBe(true);
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
