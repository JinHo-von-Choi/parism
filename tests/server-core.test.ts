/**
 * MCP core 표면 시험(run, query_result, describe). 메모리 전송으로 서버에 연결해 도구를 호출한다.
 *
 * 작성자: 최진호
 * 작성일: 2026-11-12
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client }            from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer, fitForClient, MCP_INSTRUCTIONS } from "../src/server.js";
import { DEFAULT_CONFIG }    from "../src/config/loader.js";
import { createRegistry }    from "../src/parsers/index.js";

let client: Client;
let dir: string;

beforeAll(async () => {
  dir = mkdtempSync(path.join(tmpdir(), "parism-core-"));
  for (let i = 0; i < 150; i++) writeFileSync(path.join(dir, `f${String(i).padStart(3, "0")}.txt`), "x".repeat(i));
  const config = structuredClone(DEFAULT_CONFIG);
  config.guard.allowed_paths = [dir];
  const server = createServer(config, createRegistry());
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: "test", version: "1" });
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
});

afterAll(async () => {
  await client.close();
  rmSync(dir, { recursive: true, force: true });
});

async function call(name: string, args: Record<string, unknown>): Promise<{ isError: boolean; body: Record<string, unknown>; structured: unknown }> {
  const r = await client.callTool({ name, arguments: args }) as { isError?: boolean; content: { text: string }[]; structuredContent?: unknown };
  const text = r.content[0]!.text;
  const json = text.startsWith("[cwd] ") ? text.slice(text.indexOf("\n\n") + 2) : text;
  return { isError: r.isError === true, body: JSON.parse(json) as Record<string, unknown>, structured: r.structuredContent };
}

describe("core 표면", () => {
  it("도구는 run, query_result, describe 셋이고 annotations가 있다", async () => {
    const tools = (await client.listTools()).tools;
    expect(tools.map(t => t.name).sort()).toEqual(["describe", "query_result", "run"]);
    expect(tools.find(t => t.name === "query_result")!.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false });
    expect(tools.find(t => t.name === "run")!.annotations).toMatchObject({ readOnlyHint: true, openWorldHint: true });
    expect(Buffer.byteLength(MCP_INSTRUCTIONS, "utf8")).toBeLessThanOrEqual(1536);
  });

  it("명령 한 줄과 파이프를 받는다", async () => {
    const r = await call("run", { command: `ls -la ${dir} | grep f14 | head -n 3`, cwd: dir });
    expect(r.isError).toBe(false);
    const entries = (r.body.stdout as { parsed: { entries: { name: string }[] } }).parsed.entries;
    expect(entries.map(e => e.name)).toEqual(["f140.txt", "f141.txt", "f142.txt"]);
    expect(r.body._compiled_pipeline).toMatchObject({ mode: "rows" });
    expect(r.structured).toMatchObject({ ok: true });
  });

  it("행이 많으면 미리보기와 result_id를 주고, query_result로 나머지를 읽는다", async () => {
    const r = await call("run", { command: `ls -la ${dir}`, cwd: dir });
    expect(r.body.result_id).toBeTypeOf("string");
    expect(r.body._hint).toMatch(/Showing 50 of 15[0-9] rows/);
    expect((r.body.stdout as { raw: string }).raw).toBe("");
    const q = await call("query_result", { result_id: r.body.result_id, where: [{ field: "name", op: "prefix", value: "f14" }], select: ["name"] });
    expect(q.isError).toBe(false);
    expect((q.body.value as { entries: unknown[] }).entries).toHaveLength(10);
    const ex = await call("query_result", { result_id: r.body.result_id, pointer: "/entries/0/name" });
    expect(ex.body).toMatchObject({ ok: true });
  });

  it("고급 옵션은 options 객체로 받고, 모르는 옵션은 도구 오류다", async () => {
    const r = await call("run", { command: "ls -la", cwd: dir, options: { include_raw: true, contract_version: "next", limit: 1 } as never });
    expect(r.isError).toBe(true);
    const ok = await call("run", { command: "ls -la", cwd: dir, limit: 1, options: { include_raw: true, contract_version: "next" } });
    expect((ok.body.stdout as { raw: string }).raw).not.toBe("");
    expect(ok.body.review).toBeDefined();
    const bad = await call("run", { command: "ls", cwd: dir, options: { nope: 1 } });
    expect(bad.isError).toBe(true);
    expect(JSON.stringify(bad.body)).toMatch(/unknown option/);
  });

  it("셸 문법과 가드 거절은 도구 오류이고 대안을 준다", async () => {
    const shell = await call("run", { command: "ls > out.txt", cwd: dir });
    expect(shell.isError).toBe(true);
    expect(shell.body.failure).toMatchObject({ reason: "unsupported_shell_operator", operator: ">" });
    const guard = await call("run", { command: "rm -rf x", cwd: dir });
    expect(guard.isError).toBe(true);
    expect(guard.body.failure).toMatchObject({ kind: "guard" });
  });

  it("태스크를 시작하고 task_id로 결과를 읽는다", async () => {
    const started = await call("run", { command: "ls -la", cwd: dir, mode: "task", options: { contract_version: "next" } });
    const id = (started.body.task as { task_id: string }).task_id;
    const done = await call("run", { task_id: id, wait_ms: 10_000 });
    expect(done.body).toMatchObject({ ok: true, task: { state: "completed" } });
  });

  it("describe는 명령 한 줄을 실행하지 않고 검사하고, run_options를 안내한다", async () => {
    const pass = await call("describe", { command: "git log --oneline | head -3", cwd: dir });
    expect(pass.body).toMatchObject({ would_pass: true, resolved: { cmd: "git", args: ["log", "--oneline"] } });
    const fail = await call("describe", { command: "git push", cwd: dir });
    expect(fail.body).toMatchObject({ would_pass: false, reason: "arg_not_allowed" });
    const env = await call("describe", {});
    expect(Object.keys(env.body.run_options as object)).toContain("include_raw");
    expect((env.body.side_effects as Record<string, string>).curl).toBe("network");
  });
});

describe("응답 크기 상한", () => {
  it("상한을 넘는 응답은 원문을 줄 경계에서 잘라 상한에 맞추고 페이지로 읽게 안내한다", () => {
    const raw = Array.from({ length: 4000 }, (_, i) => `line ${i} "quoted" \\ text`).join("\n") + "\n";
    const envelope = {
      ok: true, exitCode: 0, cmd: "cat", args: ["big"], cwd: "/x", duration_ms: 1,
      stdout: { raw, parsed: null }, stderr: { raw: "", parsed: null }, diff: null,
    } as unknown as Parameters<typeof fitForClient>[0];
    const fitted = fitForClient(envelope, 20_000);
    expect(Buffer.byteLength(JSON.stringify(fitted), "utf8")).toBeLessThanOrEqual(20_000);
    expect(fitted.stdout.raw.endsWith("\n")).toBe(true);
    expect(raw.startsWith(fitted.stdout.raw)).toBe(true);
    expect(fitted._hint).toMatch(/options: \{ page: 0/);
    expect(fitForClient(envelope, 10_000_000)).toBe(envelope);
  });
});
