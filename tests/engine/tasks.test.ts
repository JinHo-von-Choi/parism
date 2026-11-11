/**
 * 장기 실행 태스크 관리 시험.
 *
 * 작성자: 최진호
 * 작성일: 2026-11-11
 */

import { describe, it, expect } from "vitest";
import { TaskManager }          from "../../src/engine/tasks.js";
import type { ExecControl }     from "../../src/engine/executor.js";
import type { ResponseEnvelope } from "../../src/types/envelope.js";

const META = { cmd: "sleep", args: ["1"], cwd: "/tmp" };

function envelope(patch: Partial<ResponseEnvelope> = {}): ResponseEnvelope {
  return {
    ok: true, exitCode: 0, cmd: "sleep", args: ["1"], cwd: "/tmp", duration_ms: 1,
    stdout: { raw: "", parsed: null }, stderr: { raw: "", parsed: null }, diff: null, ...patch,
  };
}

/** 끝내는 시점을 시험이 정하는 실행. 취소 신호를 받으면 cancelled로 끝난다. */
function controllable(): { launch: (c: ExecControl) => Promise<ResponseEnvelope>; finish: (e?: ResponseEnvelope) => void } {
  let resolve!: (e: ResponseEnvelope) => void;
  const done = new Promise<ResponseEnvelope>(r => { resolve = r; });
  return {
    launch: control => {
      control.signal?.addEventListener("abort", () => resolve(envelope({
        ok: false, exitCode: 1, failure: { kind: "exec", reason: "cancelled", message: "cancelled" },
      })));
      return done;
    },
    finish: (e = envelope()) => resolve(e),
  };
}

const flush = (): Promise<void> => new Promise(r => setImmediate(r));

describe("TaskManager", () => {
  it("시작하면 식별자와 running 상태를 바로 돌려주고, 끝나면 결과를 싣는다", async () => {
    const tasks = new TaskManager({ maxConcurrency: 2, keepFinished: 4, finishedTtlMs: 60_000 });
    const run   = controllable();
    const start = tasks.start(META, run.launch);

    expect(start.ok).toBe(true);
    if (!start.ok) return;
    expect(start.task).toMatchObject({ state: "running", cmd: "sleep" });
    expect(start.task.result).toBeUndefined();

    run.finish(envelope({ stdout: { raw: "done", parsed: null } }));
    await flush();
    const status = tasks.status(start.task.task_id);
    expect(status.found && status.task.state).toBe("completed");
    expect(status.found && status.task.result?.stdout.raw).toBe("done");
  });

  it("슬롯이 차면 대기시키지 않고 거절한다", () => {
    const tasks = new TaskManager({ maxConcurrency: 1, keepFinished: 4, finishedTtlMs: 60_000 });
    expect(tasks.start(META, controllable().launch).ok).toBe(true);

    const second = tasks.start(META, controllable().launch);
    expect(second).toMatchObject({ ok: false, reason: "task_slots_full", running: 1, limit: 1 });
  });

  it("끝난 태스크는 슬롯을 돌려준다", async () => {
    const tasks = new TaskManager({ maxConcurrency: 1, keepFinished: 4, finishedTtlMs: 60_000 });
    const first = controllable();
    tasks.start(META, first.launch);
    first.finish();
    await flush();
    expect(tasks.start(META, controllable().launch).ok).toBe(true);
  });

  it("취소는 그 태스크에만 신호를 보낸다", async () => {
    const tasks = new TaskManager({ maxConcurrency: 2, keepFinished: 4, finishedTtlMs: 60_000 });
    const a = tasks.start(META, controllable().launch);
    const b = tasks.start(META, controllable().launch);
    if (!a.ok || !b.ok) throw new Error("tasks did not start");

    tasks.cancel(a.task.task_id);
    await flush();
    const afterA = tasks.status(a.task.task_id);
    const afterB = tasks.status(b.task.task_id);
    expect(afterA.found && afterA.task.state).toBe("cancelled");
    expect(afterB.found && afterB.task.state).toBe("running");
  });

  it("진행 중 받은 출력 바이트 수를 상태에 싣는다", () => {
    const tasks = new TaskManager({ maxConcurrency: 1, keepFinished: 4, finishedTtlMs: 60_000 });
    let progress!: ExecControl["onProgress"];
    const start = tasks.start(META, control => { progress = control.onProgress; return new Promise(() => {}); });
    if (!start.ok) throw new Error("task did not start");

    progress!({ stdout: 120, stderr: 7 });
    const status = tasks.status(start.task.task_id);
    expect(status.found && [status.task.stdout_bytes, status.task.stderr_bytes]).toEqual([120, 7]);
  });

  it("실행이 예외로 끝나면 실패 결과로 남긴다", async () => {
    const tasks = new TaskManager({ maxConcurrency: 1, keepFinished: 4, finishedTtlMs: 60_000 });
    const start = tasks.start(META, () => Promise.reject(new Error("boom")));
    if (!start.ok) throw new Error("task did not start");
    await flush();
    const status = tasks.status(start.task.task_id);
    expect(status.found && status.task.result?.failure).toMatchObject({ reason: "task_failed", message: "boom" });
  });

  it("모르는 식별자와 보관이 끝난 식별자를 구분한다", async () => {
    const tasks = new TaskManager({ maxConcurrency: 1, keepFinished: 1, finishedTtlMs: 60_000 });
    expect(tasks.status("task_none")).toMatchObject({ found: false, reason: "unknown_task" });

    const ids: string[] = [];
    for (let i = 0; i < 2; i++) {
      const run   = controllable();
      const start = tasks.start(META, run.launch);
      if (!start.ok) throw new Error("task did not start");
      ids.push(start.task.task_id);
      run.finish();
      await flush();
      await new Promise(r => setTimeout(r, 2));
    }
    expect(tasks.status(ids[0]!)).toMatchObject({ found: false, reason: "task_expired" });
    expect(tasks.status(ids[1]!).found).toBe(true);
  });
});

describe("TaskManager 진행 상태", () => {
  it("실행 중에는 추적기가 센 진행 상태를 싣고, 끝난 뒤에는 결과만 싣는다", async () => {
    const tasks = new TaskManager({ maxConcurrency: 1, keepFinished: 4, finishedTtlMs: 60_000 });
    let onStdout!: ExecControl["onStdout"];
    let resolve!: (e: ResponseEnvelope) => void;
    const lines: string[] = [];
    const start = tasks.start(
      META,
      control => { onStdout = control.onStdout; return new Promise(r => { resolve = r; }); },
      { push: text => { lines.push(text); }, snapshot: () => ({ seen: lines.length }) },
    );
    if (!start.ok) throw new Error("task did not start");

    onStdout!(Buffer.from("test a ... ok\n"));
    const running = tasks.status(start.task.task_id);
    expect(running.found && running.task.progress).toEqual({ seen: 1 });

    resolve(envelope());
    await flush();
    const done = tasks.status(start.task.task_id);
    expect(done.found && done.task.progress).toBeUndefined();
    expect(done.found && done.task.result?.ok).toBe(true);
  });

  it("추적기가 예외를 던져도 태스크는 계속된다", async () => {
    const tasks = new TaskManager({ maxConcurrency: 1, keepFinished: 4, finishedTtlMs: 60_000 });
    let onStdout!: ExecControl["onStdout"];
    const start = tasks.start(META, control => { onStdout = control.onStdout; return new Promise(() => {}); },
      { push: () => { throw new Error("tracker broke"); }, snapshot: () => null });
    if (!start.ok) throw new Error("task did not start");

    expect(() => onStdout!(Buffer.from("x"))).not.toThrow();
    expect(tasks.status(start.task.task_id).found).toBe(true);
  });
});
