import { describe, it, expect } from "vitest";
import { execute } from "../../src/engine/executor.js";

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
    const result = await execute("pwd", [], "/tmp");

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
