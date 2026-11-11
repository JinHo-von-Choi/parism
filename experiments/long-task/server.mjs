/**
 * 장기 실행 태스크 실험용 MCP 서버.
 *
 * 세 조건 모두 같은 엔진으로 명령을 실행한다. 도구와 시간 제한만 다르다.
 *
 *   wait      -- run 도구만 있다. 실행 시간 제한은 기본값(10초)이다
 *   wait-long -- run 도구만 있다. 실행 시간 제한을 10분으로 늘렸다
 *   task      -- run에 mode "task"가 있고 task 도구로 상태를 읽고 취소한다. 실행 시간 제한은 기본값(10초)이다
 *
 * 환경 변수: LONGTASK_ARM(wait | wait-long | task), LONGTASK_WORKDIR(명령을 실행할 디렉터리)
 *
 * 작성자: 최진호
 * 작성일: 2026-11-11
 */

import { McpServer }            from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z }                    from "zod";
import { ParismEngine }         from "../../dist/facade/engine.js";
import { DEFAULT_CONFIG }       from "../../dist/config/loader.js";
import { createRegistry }       from "../../dist/parsers/index.js";

const ARM     = process.env.LONGTASK_ARM ?? "wait";
const WORKDIR = process.env.LONGTASK_WORKDIR ?? process.cwd();

const config = structuredClone(DEFAULT_CONFIG);
config.guard.allowed_paths = [WORKDIR];
config.guard.profile       = "build";
if (!config.guard.allowed_commands.includes("cargo")) config.guard.allowed_commands.push("cargo");
if (ARM === "wait-long") config.guard.timeout_ms = 600_000;
const engine = new ParismEngine(config, createRegistry());

const text   = value => ({ content: [{ type: "text", text: JSON.stringify(value) }] });
const server = new McpServer({ name: "shell", version: "1.0.0" });
const base   = {
  cmd:  z.string().describe("Command name, e.g. cargo"),
  args: z.array(z.string()).default([]).describe("Arguments"),
};
const options = { cwd: WORKDIR, contract_version: "next", machine_format: true, format: "json" };
const RUN_DESCRIPTION =
  "Run a command without a shell and return its parsed output. Test results list every failure and only count what passed. " +
  `A command is stopped when it runs longer than ${config.guard.timeout_ms / 1000} seconds.`;

if (ARM === "task") {
  server.registerTool("run", {
    description: RUN_DESCRIPTION,
    inputSchema: {
      ...base,
      mode: z.enum(["wait", "task"]).default("wait")
        .describe("'task' starts the command, returns a task_id at once and keeps it running under the task time limit; read it with the task tool."),
    },
  }, async ({ cmd, args, mode }) => {
    if (mode !== "task") return text(await engine.run(cmd, { ...options, args }));
    const started = engine.startTask(cmd, { ...options, args });
    return text(started.started ? { task: started.task } : started.envelope);
  });
  server.registerTool("task", {
    description:
      "Read or cancel a task started by run(mode='task'). " +
      "status returns state (running, completed, cancelled), elapsed time and output bytes so far; once finished it carries the full run result. " +
      "cancel stops only that task's processes. A finished task's result is kept for a limited time and is never re-run. " +
      "Pass wait_ms with status instead of polling in a loop: the call answers when the task finishes, when a new test failure or error appears, or when the wait runs out.",
    inputSchema: {
      task_id: z.string().describe("task_id from run(mode='task')"),
      action:  z.enum(["status", "cancel"]).default("status").describe("'status' reads the task, 'cancel' stops it"),
      wait_ms: z.number().int().min(0).max(30_000).default(0)
        .describe("status only. Wait up to this many milliseconds (at most 30000) for the task to finish or a new failure to appear before answering. 0 answers at once."),
    },
  }, async ({ task_id, action, wait_ms }) => {
    const lookup = action === "cancel" ? engine.taskCancel(task_id) : await engine.taskWait(task_id, wait_ms);
    return text(lookup.found ? { ok: true, task: lookup.task } : { ok: false, reason: lookup.reason, message: lookup.message });
  });
} else {
  server.registerTool("run", { description: RUN_DESCRIPTION, inputSchema: base },
    async ({ cmd, args }) => text(await engine.run(cmd, { ...options, args })));
}

await server.connect(new StdioServerTransport());
