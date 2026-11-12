/**
 * 장기 실행 태스크 관리.
 *
 * run(mode="task")는 명령을 시작하고 식별자만 바로 돌려준다. 명령은 서버 프로세스 안에서 계속 실행되고,
 * 호출자는 식별자로 상태를 조회하거나 그 실행 하나만 취소한다.
 *
 * 태스크 슬롯은 일반 실행 슬롯과 따로 센다. 슬롯이 차면 대기시키지 않고 거절한다.
 * 긴 태스크가 일반 run을 막지 않게 하기 위해서다.
 *
 * 작성자: 최진호
 * 작성일: 2026-11-11
 */

import { randomBytes } from "node:crypto";
import type { ExecControl } from "./executor.js";
import type { ResponseEnvelope } from "../types/envelope.js";

export type TaskState = "running" | "completed" | "cancelled";

export interface TaskLimits {
  /** 동시에 실행하는 태스크 수 상한 */
  maxConcurrency: number;
  /** 끝난 태스크의 결과를 보관하는 최대 개수 */
  keepFinished:   number;
  /** 끝난 태스크의 결과를 보관하는 시간(ms) */
  finishedTtlMs:  number;
}

export const DEFAULT_TASK_RETENTION = { keepFinished: 16, finishedTtlMs: 600_000 } as const;

/** 상태 조회 한 번이 기다릴 수 있는 최대 시간(ms). 클라이언트의 요청 시간 제한보다 짧게 둔다. */
export const MAX_TASK_WAIT_MS = 30_000;

/** 태스크 한 건의 상태. result는 끝난 뒤에만 있다. */
export interface TaskSnapshot {
  task_id:      string;
  state:        TaskState;
  cmd:          string;
  args:         string[];
  cwd:          string;
  started_at:   string;
  elapsed_ms:   number;
  /** 지금까지 받은 출력 바이트 수 */
  stdout_bytes: number;
  stderr_bytes: number;
  /** 실행 중 출력으로 센 진행 상태. 진행 중 파싱을 지원하는 러너의 태스크가 실행 중일 때만 있다. */
  progress?:    unknown;
  /** run(mode: "service")로 띄운 서비스일 때만 있다 */
  service?: {
    /** 준비 조건을 만족했는지 */
    ready:         boolean;
    ready_reason?: string;
    /** 이 시각이 지나면 프로세스 그룹을 종료한다 */
    lease_until:   string;
    /** 서버가 끝나도 lease까지 남는지 */
    persist:       boolean;
    pid?:          number;
    /** 최근 출력(표준 출력과 표준 오류를 섞은 끝부분) */
    output_tail:   string;
  };
  result?:      ResponseEnvelope;
}

/** 실행 중 출력 조각을 받아 진행 상태를 세는 추적기 */
export interface TaskProgress {
  push(text: string): void;
  snapshot(): unknown;
}

export type TaskStart =
  | { ok: true;  task: TaskSnapshot }
  | { ok: false; reason: "task_slots_full"; message: string; running: number; limit: number };

export type TaskLookup =
  | { found: true;  task: TaskSnapshot }
  | { found: false; reason: "unknown_task" | "task_expired"; message: string };

interface TaskEntry {
  id:         string;
  cmd:        string;
  args:       string[];
  cwd:        string;
  startedAt:  number;
  finishedAt?: number;
  state:      TaskState;
  controller: AbortController;
  bytes:      { stdout: number; stderr: number };
  progress?:  TaskProgress;
  result?:    ResponseEnvelope;
  /** 진행 상태에서 마지막으로 본 실패 수. 늘어나면 기다리는 조회를 깨운다. */
  failures:   number;
  /** 이 태스크의 변화를 기다리는 조회 */
  waiters:    Set<() => void>;
}

/** 진행 상태에서 실패(시험)나 오류(진단) 수를 읽는다. 없으면 0이다. */
function failureCount(progress: TaskProgress | undefined): number {
  if (!progress) return 0;
  try {
    const snapshot = progress.snapshot() as { failed?: unknown; errors?: unknown } | null;
    const count    = snapshot?.failed ?? snapshot?.errors;
    return typeof count === "number" ? count : 0;
  } catch {
    return 0;
  }
}

export class TaskManager {
  private readonly tasks   = new Map<string, TaskEntry>();
  /** 보관 기간이 지나 지운 태스크. 모르는 식별자와 구분해 알려 준다. */
  private readonly expired = new Set<string>();

  constructor(private readonly limits: TaskLimits) {}

  /** 실행 중인 태스크 수 */
  get running(): number {
    let n = 0;
    for (const t of this.tasks.values()) if (t.state === "running") n++;
    return n;
  }

  /**
   * 태스크를 시작한다. 슬롯이 없으면 시작하지 않고 거절한다.
   * launch는 넘겨받은 제어 객체로 명령을 실행하고 최종 결과를 돌려준다.
   */
  start(
    meta:     { cmd: string; args: string[]; cwd: string },
    launch:   (control: ExecControl) => Promise<ResponseEnvelope>,
    progress?: TaskProgress,
  ): TaskStart {
    this.prune();
    if (this.running >= this.limits.maxConcurrency) {
      return {
        ok: false, reason: "task_slots_full", running: this.running, limit: this.limits.maxConcurrency,
        message: `${this.running} task(s) are running and the limit is ${this.limits.maxConcurrency}; wait for one to finish or cancel it`,
      };
    }
    const entry: TaskEntry = {
      id:         `task_${randomBytes(9).toString("base64url")}`,
      cmd:        meta.cmd,
      args:       [...meta.args],
      cwd:        meta.cwd,
      startedAt:  Date.now(),
      state:      "running",
      controller: new AbortController(),
      bytes:      { stdout: 0, stderr: 0 },
      failures:   0,
      waiters:    new Set(),
      ...(progress && { progress }),
    };
    const wake = (): void => {
      for (const waiter of [...entry.waiters]) waiter();
    };
    this.tasks.set(entry.id, entry);

    const control: ExecControl = {
      signal:     entry.controller.signal,
      onProgress: bytes => { entry.bytes = bytes; },
      /** 진행 상태 추적이 실패해도 실행에는 영향을 주지 않는다. */
      ...(progress && { onStdout: (chunk: Buffer) => {
        try { progress.push(chunk.toString("utf8")); } catch { /* 진행 상태만 멈춘다 */ }
        const failures = failureCount(progress);
        if (failures > entry.failures) {
          entry.failures = failures;
          wake();
        }
      } }),
    };
    const settle = (result: ResponseEnvelope): void => {
      entry.result     = result;
      entry.finishedAt = Date.now();
      entry.state      = result.failure?.reason === "cancelled" ? "cancelled" : "completed";
      wake();
    };
    launch(control).then(settle, (err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      settle({
        ok: false, exitCode: 1, cmd: entry.cmd, args: entry.args, cwd: entry.cwd,
        duration_ms: Date.now() - entry.startedAt,
        stdout: { raw: "", parsed: null }, stderr: { raw: message, parsed: null }, diff: null,
        failure: { kind: "exec", reason: "task_failed", message },
      });
    });
    return { ok: true, task: this.snapshot(entry) };
  }

  /** 태스크의 현재 상태. 끝났으면 결과를 함께 준다. */
  status(taskId: string): TaskLookup {
    this.prune();
    const entry = this.tasks.get(taskId);
    if (entry) return { found: true, task: this.snapshot(entry) };
    if (this.expired.has(taskId)) {
      return { found: false, reason: "task_expired", message: `task '${taskId}' finished and its result is no longer kept; run the command again` };
    }
    return { found: false, reason: "unknown_task", message: `task '${taskId}' is not known to this server` };
  }

  /**
   * 태스크가 끝나거나, 실패 수가 늘거나, waitMs가 지날 때까지 기다린 뒤 상태를 돌려준다.
   * 이미 끝났거나 모르는 태스크면 기다리지 않는다. waitMs는 MAX_TASK_WAIT_MS로 줄인다.
   */
  async wait(taskId: string, waitMs: number): Promise<TaskLookup> {
    const entry = this.tasks.get(taskId);
    const limit = Math.min(Math.max(0, waitMs), MAX_TASK_WAIT_MS);
    if (entry?.state === "running" && limit > 0) {
      await new Promise<void>(resolve => {
        const done = (): void => {
          clearTimeout(timer);
          entry.waiters.delete(done);
          resolve();
        };
        const timer = setTimeout(done, limit);
        entry.waiters.add(done);
      });
    }
    return this.status(taskId);
  }

  /**
   * 태스크 하나를 취소한다. 그 태스크의 프로세스 그룹에만 신호를 보낸다.
   * 이미 끝난 태스크면 아무것도 하지 않고 현재 상태를 돌려준다.
   */
  cancel(taskId: string): TaskLookup {
    const entry = this.tasks.get(taskId);
    if (entry?.state === "running") entry.controller.abort();
    return this.status(taskId);
  }

  /** 실행 중인 태스크를 모두 취소한다. */
  cancelAll(): void {
    for (const entry of this.tasks.values()) {
      if (entry.state === "running") entry.controller.abort();
    }
  }

  private snapshot(entry: TaskEntry): TaskSnapshot {
    return {
      task_id:      entry.id,
      state:        entry.state,
      cmd:          entry.cmd,
      args:         entry.args,
      cwd:          entry.cwd,
      started_at:   new Date(entry.startedAt).toISOString(),
      elapsed_ms:   (entry.finishedAt ?? Date.now()) - entry.startedAt,
      stdout_bytes: entry.bytes.stdout,
      stderr_bytes: entry.bytes.stderr,
      ...(entry.progress && entry.state === "running" && { progress: entry.progress.snapshot() }),
      ...(entry.result && { result: entry.result }),
    };
  }

  /** 끝난 태스크 가운데 보관 기간이 지났거나 보관 개수를 넘은 것을 지운다. 오래된 것부터 지운다. */
  private prune(): void {
    const now      = Date.now();
    const finished = [...this.tasks.values()].filter(t => t.finishedAt !== undefined)
      .sort((a, b) => a.finishedAt! - b.finishedAt!);
    const excess = Math.max(0, finished.length - this.limits.keepFinished);
    finished.forEach((t, index) => {
      if (index < excess || now - t.finishedAt! > this.limits.finishedTtlMs) {
        this.tasks.delete(t.id);
        this.expired.add(t.id);
      }
    });
  }
}
