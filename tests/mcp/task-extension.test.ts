/**
 * MCP 태스크 확장 어댑터 시험. SDK 클라이언트로 서버에 연결해 프로토콜의 태스크 요청을 실제로 주고받는다.
 *
 * 이 어댑터는 MCP SDK의 experimental 태스크 API에 기댄다. SDK의 그 API가 바뀌면 이 시험이 먼저 깨진다.
 *
 * 작성자: 최진호
 * 작성일: 2026-11-11
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, writeFileSync }      from "node:fs";
import { tmpdir }                          from "node:os";
import path                                from "node:path";
import { Client }                          from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport }               from "@modelcontextprotocol/sdk/inMemory.js";
import { CallToolResultSchema }            from "@modelcontextprotocol/sdk/types.js";
import { createServer, loadTaskExtension } from "../../src/server.js";
import { DEFAULT_CONFIG, type PrismConfig } from "../../src/config/loader.js";
import { createRegistry }                  from "../../src/parsers/index.js";

let work:   string;
let client: Client;

function configFor(patch: (c: PrismConfig) => void = () => {}): PrismConfig {
  const config = structuredClone(DEFAULT_CONFIG);
  config.guard.allowed_paths = [work];
  config.guard.allowed_commands.push("sleep");
  config.tasks = { max_concurrency: 1, timeout_ms: 60_000, mcp_extension: true };
  patch(config);
  return config;
}

async function connect(config: PrismConfig): Promise<Client> {
  const server = createServer(config, createRegistry(), await loadTaskExtension(config));
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const c = new Client({ name: "test", version: "1" }, { capabilities: { tasks: { list: {}, cancel: {}, requests: {} } } });
  await Promise.all([server.connect(serverSide), c.connect(clientSide)]);
  return c;
}

const wait = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms));

/** run_task를 태스크 요청으로 부르고 만들어진 태스크를 돌려준다. */
async function startTask(c: Client, args: Record<string, unknown>): Promise<{ taskId: string; status: string; statusMessage?: string }> {
  for await (const message of c.experimental.tasks.callToolStream({ name: "run_task", arguments: args }, CallToolResultSchema, { task: { ttl: 60_000 } })) {
    if (message.type === "taskCreated") return message.task;
    if (message.type === "error") throw message.error;
  }
  throw new Error("no task was created");
}

/** 도구 결과 텍스트에서 cwd 배너를 떼고 봉투를 읽는다. */
function envelopeOf(result: { content: unknown }): { ok: boolean; stdout: { parsed: { entries: unknown[] } | null }; failure?: { kind: string; reason: string } } {
  const text = (result.content as { text: string }[])[0]!.text;
  return JSON.parse(text.slice(text.indexOf("\n\n") + 2));
}

beforeAll(async () => {
  work = mkdtempSync(path.join(tmpdir(), "parism-mcp-task-"));
  for (let i = 0; i < 3; i++) writeFileSync(path.join(work, `f${i}.txt`), "x");
  client = await connect(configFor());
});

afterAll(async () => {
  await client.close();
});

describe("MCP 태스크 확장", () => {
  it("켜면 서버가 태스크 기능을 선언하고 run_task 도구를 노출한다", async () => {
    expect(client.getServerCapabilities()?.tasks).toEqual({ list: {}, cancel: {}, requests: { tools: { call: {} } } });
    const tool = (await client.listTools()).tools.find(t => t.name === "run_task");
    expect(tool?.execution?.taskSupport).toBe("required");
    expect(Object.keys(tool!.inputSchema.properties ?? {})).toEqual(expect.arrayContaining(["cmd", "args", "cwd", "machine_format"]));
    expect(tool!.inputSchema.properties).not.toHaveProperty("mode");
  });

  it("끄면 태스크 기능도 run_task 도구도 없고, 어댑터 모듈을 불러오지 않는다", async () => {
    const off = configFor(c => { c.tasks = { max_concurrency: 1, timeout_ms: 60_000 }; });
    expect(await loadTaskExtension(off)).toBeUndefined();
    const plain = await connect(off);
    try {
      expect(plain.getServerCapabilities()?.tasks).toBeUndefined();
      expect((await plain.listTools()).tools.map(t => t.name)).not.toContain("run_task");
    } finally {
      await plain.close();
    }
  });

  it("태스크 요청으로 부르면 태스크를 바로 돌려주고, 끝난 뒤 tasks/result로 run과 같은 결과를 준다", async () => {
    const task = await startTask(client, { cmd: "ls", args: ["-l", work], cwd: work });
    expect(task.status).toBe("working");

    let current = await client.experimental.tasks.getTask(task.taskId);
    for (let i = 0; i < 40 && current.status === "working"; i++) {
      await wait(100);
      current = await client.experimental.tasks.getTask(task.taskId);
    }
    expect(current.status).toBe("completed");

    const result = envelopeOf(await client.experimental.tasks.getTaskResult(task.taskId, CallToolResultSchema));
    expect(result.ok).toBe(true);
    expect(result.stdout.parsed?.entries).toHaveLength(3);
  });

  it("실행 중인 태스크를 조회하면 진행 상태 문구가 실리고, tasks/cancel은 그 명령을 끝낸다", async () => {
    const task = await startTask(client, { cmd: "sleep", args: ["30"], cwd: work });
    await wait(300);

    const running = await client.experimental.tasks.getTask(task.taskId);
    expect(running.status).toBe("working");
    expect(running.statusMessage).toMatch(/^running \d+s, \d+ bytes of output so far$/);

    const cancelled = await client.experimental.tasks.cancelTask(task.taskId);
    expect(cancelled.status).toBe("cancelled");

    /** 엔진 태스크도 끝나야 다음 태스크가 슬롯을 얻는다(슬롯은 1개다). */
    await wait(700);
    const next = await startTask(client, { cmd: "ls", args: ["-l", work], cwd: work });
    expect(next.status).toBe("working");
    for (let i = 0; i < 40 && (await client.experimental.tasks.getTask(next.taskId)).status === "working"; i++) await wait(100);
  });

  it("가드가 막은 명령은 실패한 태스크로 돌려주고 사유를 결과에 싣는다", async () => {
    const task = await startTask(client, { cmd: "rm", args: ["-rf", work], cwd: work });
    expect(task.status).toBe("failed");
    expect(task.statusMessage).toMatch(/not in the allowed list/);

    const result = envelopeOf(await client.experimental.tasks.getTaskResult(task.taskId, CallToolResultSchema));
    expect(result.failure).toMatchObject({ kind: "guard", reason: "command_not_allowed" });
  });

  it("슬롯이 차면 대기시키지 않고 실패한 태스크로 돌려준다", async () => {
    const first  = await startTask(client, { cmd: "sleep", args: ["30"], cwd: work });
    const second = await startTask(client, { cmd: "sleep", args: ["30"], cwd: work });
    expect(second.status).toBe("failed");

    const result = envelopeOf(await client.experimental.tasks.getTaskResult(second.taskId, CallToolResultSchema));
    expect(result.failure?.reason).toBe("task_slots_full");

    await client.experimental.tasks.cancelTask(first.taskId);
    await wait(700);
  });

  it("태스크 요청 없이 부르면 거절한다", async () => {
    await expect(client.callTool({ name: "run_task", arguments: { cmd: "ls", args: ["-l", work], cwd: work } }))
      .rejects.toThrow(/run_task.*requires? task/i);
  });

  it("tasks/list로 만든 태스크를 볼 수 있다", async () => {
    const listed = await client.experimental.tasks.listTasks();
    expect(listed.tasks.length).toBeGreaterThan(0);
    expect(listed.tasks.every(t => typeof t.taskId === "string")).toBe(true);
  });
});
