/**
 * MCP 태스크 확장 어댑터.
 *
 * MCP 클라이언트가 프로토콜의 태스크 요청(tools/call의 task 인자, tasks/get, tasks/result, tasks/cancel)으로
 * Parism의 장기 실행 태스크를 쓰게 한다. 태스크의 실행, 슬롯, 시간 제한, 취소는 엔진의 TaskManager가 그대로 맡고,
 * 이 모듈은 그 상태를 프로토콜의 태스크 저장소로 옮겨 주기만 한다.
 *
 * SDK의 태스크 API는 experimental이고 예고 없이 바뀔 수 있다. 그래서
 *   - SDK의 experimental 경로를 가져오는 곳은 이 파일 하나다.
 *   - tasks.mcp_extension 설정을 켰을 때만 이 모듈을 불러 쓴다. 기본값은 꺼짐이다.
 *   - 이 모듈이 기대는 SDK의 모양은 tests/mcp/task-extension.test.ts가 확인한다.
 * SDK가 바뀌면 고칠 곳은 이 파일이다. 엔진과 `task` 도구는 영향을 받지 않는다.
 *
 * 작성자: 최진호
 * 작성일: 2026-11-11
 */

import type { McpServer }  from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult, Request, RequestId, Result, Task } from "@modelcontextprotocol/sdk/types.js";
import {
  InMemoryTaskMessageQueue, InMemoryTaskStore, isTerminal,
  type CreateTaskOptions, type TaskMessageQueue, type TaskStore,
} from "@modelcontextprotocol/sdk/experimental/tasks/index.js";
import type { ZodRawShape } from "zod";
import type { ParismEngine, RunOptions } from "../facade/engine.js";
import type { ResponseEnvelope }         from "../types/envelope.js";
import type { TaskSnapshot }             from "../engine/tasks.js";

/** 서버가 선언하는 태스크 기능. tools/call을 태스크로 만들 수 있고, 목록 조회와 취소를 받는다. */
export const TASK_CAPABILITIES = { tasks: { list: {}, cancel: {}, requests: { tools: { call: {} } } } } as const;

/** 프로토콜 태스크의 상태 조회 권장 간격(ms) */
const POLL_INTERVAL_MS = 1000;
/** 끝난 태스크의 결과를 프로토콜 저장소에 두는 시간(ms). 엔진의 보관 시간과 같다. */
const RESULT_TTL_MS = 600_000;

/** 엔진 태스크의 진행 상태를 한 줄 문구로 만든다. */
function describeProgress(task: TaskSnapshot): string {
  const seconds  = Math.round(task.elapsed_ms / 1000);
  const progress = task.progress as { passed?: number; failed?: number; skipped?: number } | undefined;
  if (progress && typeof progress.passed === "number" && typeof progress.failed === "number") {
    return `running ${seconds}s: ${progress.passed} passed, ${progress.failed} failed, ${progress.skipped ?? 0} skipped so far`;
  }
  return `running ${seconds}s, ${task.stdout_bytes} bytes of output so far`;
}

/**
 * 프로토콜 태스크 저장소. SDK의 메모리 저장소에 두 가지를 더한다.
 *   - 취소: 클라이언트가 tasks/cancel을 보내면 SDK가 상태를 cancelled로 바꾼다. 그때 엔진 태스크도 취소한다.
 *   - 진행 상태: 실행 중인 태스크를 조회하면 엔진이 센 진행 상태를 statusMessage에 싣는다.
 */
export class BridgedTaskStore implements TaskStore {
  private readonly inner = new InMemoryTaskStore();
  /** 프로토콜 태스크 id → 엔진 태스크 id */
  private readonly engineIds = new Map<string, string>();

  constructor(private readonly engine: Pick<ParismEngine, "taskStatus" | "taskCancel">) {}

  /** 프로토콜 태스크와 엔진 태스크를 짝짓는다. */
  bind(taskId: string, engineTaskId: string): void {
    this.engineIds.set(taskId, engineTaskId);
  }

  createTask(taskParams: CreateTaskOptions, requestId: RequestId, request: Request, sessionId?: string): Promise<Task> {
    return this.inner.createTask(taskParams, requestId, request, sessionId);
  }

  async getTask(taskId: string, sessionId?: string): Promise<Task | null> {
    const task = await this.inner.getTask(taskId, sessionId);
    if (!task || isTerminal(task.status)) return task;
    const engineId = this.engineIds.get(taskId);
    const lookup   = engineId ? this.engine.taskStatus(engineId) : undefined;
    return lookup?.found && lookup.task.state === "running" ? { ...task, statusMessage: describeProgress(lookup.task) } : task;
  }

  storeTaskResult(taskId: string, status: "completed" | "failed", result: Result, sessionId?: string): Promise<void> {
    return this.inner.storeTaskResult(taskId, status, result, sessionId);
  }

  getTaskResult(taskId: string, sessionId?: string): Promise<Result> {
    return this.inner.getTaskResult(taskId, sessionId);
  }

  async updateTaskStatus(taskId: string, status: Task["status"], statusMessage?: string, sessionId?: string): Promise<void> {
    await this.inner.updateTaskStatus(taskId, status, statusMessage, sessionId);
    if (status === "cancelled") {
      const engineId = this.engineIds.get(taskId);
      if (engineId) this.engine.taskCancel(engineId);
    }
  }

  listTasks(cursor?: string, sessionId?: string): Promise<{ tasks: Task[]; nextCursor?: string }> {
    return this.inner.listTasks(cursor, sessionId);
  }

  /** 보관 타이머를 정리한다. 서버를 끝낼 때 부른다. */
  cleanup(): void {
    this.inner.cleanup();
    this.engineIds.clear();
  }
}

/** McpServer를 만들 때 넘길 태스크 저장소와 메시지 큐 */
export interface TaskExtensionParts {
  taskStore:        BridgedTaskStore;
  taskMessageQueue: TaskMessageQueue;
}

export function createTaskExtensionParts(engine: Pick<ParismEngine, "taskStatus" | "taskCancel">): TaskExtensionParts {
  return { taskStore: new BridgedTaskStore(engine), taskMessageQueue: new InMemoryTaskMessageQueue() };
}

/**
 * 엔진 태스크가 끝날 때까지 기다린다. 엔진은 끝난 사실을 알려 주지 않으므로 상태를 주기적으로 본다.
 * 엔진이 그 태스크를 모르게 되면(보관이 끝남) undefined를 돌려준다.
 */
async function waitForEngineTask(
  engine: Pick<ParismEngine, "taskStatus">, engineTaskId: string, intervalMs: number,
): Promise<ResponseEnvelope | undefined> {
  for (;;) {
    const lookup = engine.taskStatus(engineTaskId);
    if (!lookup.found) return undefined;
    if (lookup.task.state !== "running") return lookup.task.result;
    await new Promise(resolve => setTimeout(resolve, intervalMs));
  }
}

/**
 * `run_task` 도구를 등록한다. 태스크 요청으로만 부를 수 있다(taskSupport: required).
 * 입력은 run과 같고, 결과(tasks/result)는 run과 같은 봉투다.
 *
 * render는 봉투를 도구 결과 텍스트로 만드는 함수다. run과 같은 모양(cwd 배너 포함)을 쓰도록 서버가 넘긴다.
 */
export function registerRunTask(
  server:      McpServer,
  engine:      Pick<ParismEngine, "startTask" | "taskStatus">,
  store:       BridgedTaskStore,
  inputSchema: ZodRawShape,
  render:      (envelope: ResponseEnvelope) => string,
  options:     { settleIntervalMs?: number } = {},
): void {
  const settleInterval = options.settleIntervalMs ?? 250;
  const toResult = (envelope: ResponseEnvelope): CallToolResult => ({ content: [{ type: "text", text: render(envelope) }] });

  server.experimental.tasks.registerToolTask(
    "run_task",
    {
      description:
        "Run a command as an MCP task. Call it with task augmentation; it returns a task at once and the command keeps running " +
        "under the task time limit. Poll tasks/get (statusMessage carries progress), read the run result with tasks/result, " +
        "stop it with tasks/cancel. Same inputs and same result as run with contract_version 'next'. " +
        "Clients without MCP task support use run(mode='task') and the task tool instead.",
      inputSchema,
      execution: { taskSupport: "required" },
    },
    {
      createTask: async (args, extra) => {
        const { cmd, ...rest } = args as unknown as { cmd: string } & RunOptions;
        const task    = await extra.taskStore.createTask({ ttl: RESULT_TTL_MS, pollInterval: POLL_INTERVAL_MS });
        const started = engine.startTask(cmd, { ...rest, contract_version: "next" });

        /** 가드가 막았거나 슬롯이 없으면 시작하지 않은 사유를 결과로 남기고 실패로 끝낸다. */
        if (!started.started) {
          await extra.taskStore.storeTaskResult(task.taskId, "failed", toResult(started.envelope));
          return { task: { ...task, status: "failed" as const, statusMessage: started.envelope.failure?.message } };
        }
        store.bind(task.taskId, started.task.task_id);

        /** 끝나면 결과를 저장소에 옮긴다. 그 사이 취소됐으면 저장소가 이미 끝난 상태라 옮기지 않는다. */
        void waitForEngineTask(engine, started.task.task_id, settleInterval).then(async envelope => {
          const current = await store.getTask(task.taskId);
          if (!current || isTerminal(current.status)) return;
          if (envelope) await store.storeTaskResult(task.taskId, "completed", toResult(envelope));
          else          await store.updateTaskStatus(task.taskId, "failed", "the task result is no longer kept");
        }).catch((err: unknown) => {
          process.stderr.write(`[parism] WARNING: task result was not stored: ${err instanceof Error ? err.message : String(err)}\n`);
        });
        return { task };
      },
      getTask: async (_args, extra) => {
        const task = await extra.taskStore.getTask(extra.taskId);
        if (!task) throw new Error(`task '${extra.taskId}' is not known to this server`);
        return task;
      },
      getTaskResult: async (_args, extra) => await extra.taskStore.getTaskResult(extra.taskId) as CallToolResult,
    },
  );
}
