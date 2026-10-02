import { describe, it, expect } from "vitest";
import { execute, truncateUtf8Lines, trackedProcessGroups, terminateProcessGroups } from "../../src/engine/executor.js";

describe("execute()", () => {
  it("echo 명령을 실행하고 stdout을 반환한다", async () => {
    const result = await execute("echo", ["hello"], process.cwd());

    expect(result.ok).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(result.cmd).toBe("echo");
    expect(result.args).toEqual(["hello"]);
    expect(result.stdout.raw.trim()).toBe("hello");
    expect(result.stderr.raw).toBe("");
    expect(result.duration_ms).toBeGreaterThanOrEqual(0);
    expect(result.diff).not.toBeNull();
    expect(result.diff).toHaveProperty("created");
    expect(result.diff).toHaveProperty("deleted");
    expect(result.diff).toHaveProperty("modified");
  });

  it("존재하지 않는 명령은 ok=false를 반환한다", async () => {
    const result = await execute("__nonexistent_command__", [], process.cwd());

    expect(result.ok).toBe(false);
    expect(result.exitCode).not.toBe(0);
    expect(result.failure?.kind).toBe("exec");
    expect(result.failure?.reason).toBe("spawn_failed");
  });

  it("실패한 명령은 ok=false를 반환한다", async () => {
    const result = await execute("ls", ["/tmp/__prism_test_nonexistent__"], process.cwd());

    expect(result.ok).toBe(false);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.raw.length).toBeGreaterThan(0);
    expect(result.failure?.kind).toBe("exec");
    expect(result.failure?.reason).toBe("non_zero_exit");
  });

  it("cwd가 응답에 포함된다", async () => {
    const result = await execute("pwd", [], "/tmp", [], 10000, 0, false);

    expect(result.cwd).toBe("/tmp");
    expect(result.stdout.raw.trim()).toBe("/tmp");
  });

  it("maxOutputBytes 초과 시 truncated=true로 잘라낸다", async () => {
    // echo로 50바이트 초과 출력 생성 (a×60 + newline = 61바이트)
    const result = await execute("echo", ["a".repeat(60)], process.cwd(), [], 5000, 50);

    expect(result.ok).toBe(true);
    expect(result.truncated).toBe(true);
    expect(result.stdout.raw).toContain("[truncated:");
  });

  it("maxOutputBytes=0이면 자르지 않는다", async () => {
    const result = await execute("echo", ["hello world"], process.cwd(), [], 5000, 0);

    expect(result.truncated).toBeUndefined();
    expect(result.stdout.raw.trim()).toBe("hello world");
  });

  it("includeDiff=false면 스냅샷을 생략하고 diff가 null이다", async () => {
    const result = await execute("echo", ["hello"], process.cwd(), [], 5000, 0, false);

    expect(result.ok).toBe(true);
    expect(result.diff).toBeNull();
  });

  it("타임아웃 초과 시 failure.reason=timeout을 반환한다", async () => {
    const result = await execute("sleep", ["5"], process.cwd(), [], 50);

    expect(result.ok).toBe(false);
    expect(result.failure?.kind).toBe("exec");
    expect(result.failure?.reason).toBe("timeout");
  }, 10000);
});

describe("출력 상한", () => {
  it("stderr도 max_output_bytes로 자른다", async () => {
    const r = await execute("node", ["-e", "process.stderr.write('x'.repeat(5000))"], process.cwd(), [], 10000, 100, false);
    expect(Buffer.byteLength(r.stderr.raw)).toBeLessThan(200);
    expect(r.truncated).toBe(true);
  });

  it("maxBuffer 초과는 output_overflow로 분류한다", async () => {
    const r = await execute("node", ["-e", "process.stdout.write('x'.repeat(11*1024*1024))"], process.cwd(), [], 10000, 0, false);
    expect(r.failure?.reason).toBe("output_overflow");
  });

  it("truncateUtf8Lines 는 마지막 완전한 줄까지 남긴다", () => {
    const r = truncateUtf8Lines("aaa\nbbb\nccc\n", 9);
    expect(r.truncated).toBe(true);
    expect(r.text.startsWith("aaa\nbbb\n")).toBe(true);
    expect(r.text).not.toContain("ccc");
    expect(truncateUtf8Lines("abc", 0)).toEqual({ text: "abc", truncated: false });
  });
});

describe("타임아웃 시 프로세스 그룹 종료", () => {
  /** pid가 살아 있는지 확인한다. 신호 0은 존재 여부만 검사한다. */
  function alive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch (err) {
      return (err as NodeJS.ErrnoException).code !== "ESRCH";
    }
  }

  it.skipIf(process.platform === "win32")("자식이 띄운 손자 프로세스도 타임아웃 뒤 남지 않는다", async () => {
    const script = [
      "const { spawn } = require('node:child_process');",
      "const g = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });",
      "process.stdout.write(String(g.pid) + '\\n');",
      "setInterval(() => {}, 1000);",
    ].join("\n");
    const r   = await execute(process.execPath, ["-e", script], process.cwd(), [], 1500, 0, false);
    const pid = Number(r.stdout.raw.trim());
    try {
      expect(r.failure?.reason).toBe("timeout");
      expect(Number.isInteger(pid) && pid > 0).toBe(true);
      const deadline = Date.now() + 3000;
      while (alive(pid) && Date.now() < deadline) await new Promise(res => setTimeout(res, 50));
      expect(alive(pid)).toBe(false);
    } finally {
      if (pid > 0 && alive(pid)) process.kill(pid, "SIGKILL");
    }
  }, 15000);

  it("timeoutMs가 0이면 시간 제한 없이 끝까지 실행한다", async () => {
    const r = await execute(process.execPath, ["-e", "setTimeout(() => process.stdout.write('done'), 100)"], process.cwd(), [], 0, 0, false);
    expect(r.ok).toBe(true);
    expect(r.stdout.raw).toBe("done");
  });

  it("종료 코드가 0이 아니면 그 코드를 돌려준다", async () => {
    const r = await execute(process.execPath, ["-e", "process.exit(3)"], process.cwd(), [], 5000, 0, false);
    expect(r.exitCode).toBe(3);
    expect(r.failure?.reason).toBe("non_zero_exit");
  });
});

/** 조건이 참이 될 때까지 짧게 기다린다. 제한 시간이 지나면 그대로 돌아온다. */
async function waitFor(cond: () => boolean, limitMs = 3000): Promise<void> {
  const deadline = Date.now() + limitMs;
  while (!cond() && Date.now() < deadline) await new Promise(res => setTimeout(res, 20));
}

describe.skipIf(process.platform === "win32")("프로세스 그룹 추적", () => {
  it("실행 중인 그룹을 추적하고 결과가 확정되면 지운다", async () => {
    const before  = trackedProcessGroups().size;
    const pending = execute(process.execPath, ["-e", "setTimeout(() => {}, 300)"], process.cwd(), [], 5000, 0, false);
    await waitFor(() => trackedProcessGroups().size === before + 1);
    expect(trackedProcessGroups().size).toBe(before + 1);
    const r = await pending;
    expect(r.ok).toBe(true);
    expect(trackedProcessGroups().size).toBe(before);
  });

  it("terminateProcessGroups는 추적 중인 그룹을 종료한다", async () => {
    const pending = execute(process.execPath, ["-e", "setInterval(() => {}, 1000)"], process.cwd(), [], 0, 0, false);
    await waitFor(() => trackedProcessGroups().size > 0);
    terminateProcessGroups();
    const r = await pending;
    expect(r.ok).toBe(false);
    expect(trackedProcessGroups().size).toBe(0);
  }, 10000);
});
