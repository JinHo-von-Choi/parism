/**
 * 서비스 lease 시험. 실제 HTTP 서버를 띄우고 준비 판정, 요청, lease 만료, 취소를 확인한다.
 *
 * 작성자: 최진호
 * 작성일: 2026-11-12
 */

import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import http from "node:http";
import { execFileSync } from "node:child_process";
import { ParismEngine } from "../../src/facade/engine.js";
import { DEFAULT_CONFIG } from "../../src/config/loader.js";
import { createRegistry } from "../../src/parsers/index.js";

const dir = mkdtempSync(path.join(tmpdir(), "parism-svc-"));
const PORT = 20000 + Math.floor(Math.random() * 20000);
writeFileSync(path.join(dir, "server.js"), `
const http = require("http");
const port = Number(process.argv[2]);
setTimeout(() => http.createServer((q, s) => s.end("pong")).listen(port, "127.0.0.1", () => console.log("Listening on " + port)), 300);
`);

const config = structuredClone(DEFAULT_CONFIG);
config.guard.allowed_paths    = [dir];
config.guard.profile          = "build";
config.guard.allowed_commands = [...config.guard.allowed_commands, "node"];
const engine = new ParismEngine(config, createRegistry());

function get(port: number): Promise<string> {
  return new Promise((resolve, reject) => {
    http.get({ host: "127.0.0.1", port, path: "/" }, res => {
      let body = "";
      res.on("data", c => { body += c; });
      res.on("end", () => resolve(body));
    }).on("error", reject);
  });
}

afterAll(() => {
  engine.cancelAllTasks();
  rmSync(dir, { recursive: true, force: true });
});

describe("run(mode: service)", () => {
  it("ready_pattern이 나오면 준비로 보고 돌려주며, 서버는 계속 응답한다", async () => {
    const started = await engine.startService("", { command: `node server.js ${PORT}`, cwd: dir, ready_pattern: "Listening on", lease_ms: 20_000 });
    expect(started.started).toBe(true);
    if (!started.started) return;
    expect(started.task.service).toMatchObject({ ready: true, ready_reason: "output matched Listening on" });
    expect(started.task.service?.output_tail).toContain(`Listening on ${PORT}`);
    expect(await get(PORT)).toBe("pong");

    const stopped = engine.taskCancel(started.task.task_id);
    expect(stopped.found).toBe(true);
    const after = await engine.taskWait(started.task.task_id, 5_000);
    expect(after.found && after.task.state).toBe("cancelled");
    await expect(get(PORT)).rejects.toThrow();
  });

  it("ready_port가 열리면 준비로 본다", async () => {
    const port = PORT + 1;
    const started = await engine.startService("node", { args: ["server.js", String(port)], cwd: dir, ready_port: port, lease_ms: 20_000 });
    expect(started.started && started.task.service?.ready_reason).toBe(`port ${port} accepts connections`);
    expect(await get(port)).toBe("pong");
    if (started.started) engine.taskCancel(started.task.task_id);
  });

  it("lease가 지나면 프로세스 그룹째 종료한다", async () => {
    const port = PORT + 2;
    const started = await engine.startService("", { command: `node server.js ${port}`, cwd: dir, ready_port: port, lease_ms: 1_500 });
    expect(started.started).toBe(true);
    if (!started.started) return;
    expect(await get(port)).toBe("pong");
    const after = await engine.taskWait(started.task.task_id, 6_000);
    expect(after.found && after.task.state).toBe("cancelled");
    expect(after.found && after.task.service?.ready_reason).toBe("lease expired");
    await expect(get(port)).rejects.toThrow();
  });

  it("persist는 호스트 설정 없이 거절하고, 파이프와 가드 위반도 거절한다", async () => {
    const persist = await engine.startService("", { command: `node server.js ${PORT + 3}`, cwd: dir, persist: true });
    expect(!persist.started && persist.envelope.failure?.reason).toBe("persist_not_allowed");
    const pipe = await engine.startService("", { command: "node server.js 1 | grep x", cwd: dir });
    expect(!pipe.started && pipe.envelope.failure?.reason).toBe("unsupported_shell_operator");
    const guard = await engine.startService("", { command: "rm -rf x", cwd: dir });
    expect(!guard.started && guard.envelope.failure?.kind).toBe("guard");
  });

  it("persist 서비스는 서버 프로세스가 끝나도 남았다가 lease 끝에 종료된다", async () => {
    const port = PORT + 4;
    const home = mkdtempSync(path.join(tmpdir(), "parism-svc-home-"));
    /** 별도 프로세스에서 엔진을 만들고 서비스를 띄운 뒤 그 프로세스를 끝낸다 */
    const script = `
      import { ParismEngine } from ${JSON.stringify(path.resolve("dist/facade/engine.js"))};
      import { DEFAULT_CONFIG } from ${JSON.stringify(path.resolve("dist/config/loader.js"))};
      import { createRegistry } from ${JSON.stringify(path.resolve("dist/parsers/index.js"))};
      const c = structuredClone(DEFAULT_CONFIG);
      c.guard.allowed_paths = [${JSON.stringify(dir)}]; c.guard.profile = "build"; c.guard.allowed_commands.push("node");
      c.tasks = { ...c.tasks, allow_persistent_services: true };
      const e = new ParismEngine(c, createRegistry());
      const r = await e.startService("", { command: "node server.js ${port}", cwd: ${JSON.stringify(dir)}, ready_port: ${port}, lease_ms: 4000, persist: true });
      console.log(JSON.stringify({ started: r.started, ready: r.started && r.task.service.ready }));
      process.exit(0);`;
    const out = execFileSync(process.execPath, ["--input-type=module", "-e", script], { env: { ...process.env, PARISM_HOME: home } }).toString();
    expect(JSON.parse(out.trim().split("\n").pop()!)).toEqual({ started: true, ready: true });
    expect(await get(port)).toBe("pong");
    await new Promise(r => setTimeout(r, 7_000));
    await expect(get(port)).rejects.toThrow();
    rmSync(home, { recursive: true, force: true });
  }, 20_000);
});
