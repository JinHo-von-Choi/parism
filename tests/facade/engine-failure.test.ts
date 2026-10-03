import { describe, it, expect, vi } from "vitest";
import type { FailureInfo, ResponseEnvelope } from "../../src/types/envelope.js";

/** 다음 execute 호출이 돌려줄 실행 결과 */
const next: { stdout: string; stderr: string; failure?: FailureInfo } = { stdout: "", stderr: "" };

vi.mock("../../src/engine/executor.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/engine/executor.js")>();
  return {
    ...actual,
    execute: vi.fn(async (cmd: string, args: string[], cwd: string): Promise<ResponseEnvelope> => ({
      ok:          next.failure === undefined,
      exitCode:    next.failure === undefined ? 0 : 2,
      cmd, args, cwd,
      duration_ms: 0,
      stdout:      { raw: next.stdout, parsed: null },
      stderr:      { raw: next.stderr, parsed: null },
      diff:        null,
      ...(next.failure && { failure: next.failure }),
    })),
  };
});

const { ParismEngine }   = await import("../../src/facade/engine.js");
const { DEFAULT_CONFIG } = await import("../../src/config/loader.js");
const { createRegistry } = await import("../../src/parsers/index.js");

const engine = new ParismEngine(DEFAULT_CONFIG, createRegistry());

/** 실행 결과를 정하고 엔진을 돌린다. */
async function runWith(cmd: string, args: string[], stdout: string, stderr: string, failure?: FailureInfo): Promise<ResponseEnvelope> {
  next.stdout  = stdout;
  next.stderr  = stderr;
  next.failure = failure;
  return engine.run(cmd, { args });
}

describe("실행 실패와 파싱 오류가 겹친 결과", () => {
  it("이름을 풀지 못한 ping은 실행 실패와 stderr 메시지를 유지한다", async () => {
    const stderr = "ping: no-such-host.invalid: Name or service not known\n";
    const r      = await runWith("ping", ["-c", "1", "no-such-host.invalid"], "", stderr,
      { kind: "exec", reason: "non_zero_exit", message: `Command failed: ping -c 1 no-such-host.invalid\n${stderr}` });

    expect(r.ok).toBe(false);
    expect(r.failure).toMatchObject({ kind: "exec", reason: "non_zero_exit" });
    expect(r.failure?.message).toContain("Name or service not known");
    expect(r.stderr.raw).toBe(stderr);
    expect(r.stdout.parsed).toBeNull();
    expect(r.stdout.parse_error?.reason).toBe("unrecognized_output");
  });

  it("시간 초과는 파싱 오류가 있어도 timeout으로 남는다", async () => {
    const r = await runWith("ping", ["-c", "100", "example.com"], "PING example.com (93.184.216.34) 56(84) bytes of data.\n", "",
      { kind: "exec", reason: "timeout", message: "Command timed out after 10000 ms: ping -c 100 example.com" });

    expect(r.failure).toEqual({ kind: "exec", reason: "timeout", message: "Command timed out after 10000 ms: ping -c 100 example.com" });
    expect(r.stdout.parse_error?.reason).toBe("unrecognized_output");
  });

  it("없는 사용자의 id는 실행 실패와 stderr 메시지를 유지한다", async () => {
    const stderr = "id: 'nobody-here': no such user\n";
    const r      = await runWith("id", ["nobody-here"], "", stderr,
      { kind: "exec", reason: "non_zero_exit", message: `Command failed: id nobody-here\n${stderr}` });

    expect(r.failure).toMatchObject({ kind: "exec", reason: "non_zero_exit", message: expect.stringContaining("no such user") });
    expect(r.stdout.parse_error?.reason).toBe("unrecognized_output");
  });

  it("실행 실패에서 형식 밖 인자의 안내는 stdout.parse_error에 남는다", async () => {
    const r = await runWith("uname", ["-r"], "", "uname: broken\n", { kind: "exec", reason: "non_zero_exit", message: "Command failed: uname -r\nuname: broken\n" });

    expect(r.failure).toMatchObject({ kind: "exec", reason: "non_zero_exit" });
    expect(r.failure?.hint).toBeUndefined();
    expect(r.stdout.parse_error).toMatchObject({ reason: "unsupported_format", hint: { args: ["-a"] } });
  });

  it("종료 코드가 0이고 stdout이 비고 stderr만 있으면 파싱 오류를 실패로 올리지 않는다", async () => {
    const r = await runWith("curl", ["-sI", "http://example.invalid"], "", "curl: (6) Could not resolve host\n");

    expect(r.ok).toBe(true);
    expect(r.failure).toBeUndefined();
    expect(r.stdout.parse_error?.reason).toBe("unrecognized_output");
  });

  it("실행이 성공하고 stdout에 데이터가 있으면 파싱 오류가 failure가 된다", async () => {
    const r = await runWith("ping", ["-c", "1", "example.com"], "garbage line\n", "");

    expect(r.ok).toBe(true);
    expect(r.failure).toMatchObject({ kind: "parse", reason: "unrecognized_output" });
  });
});
