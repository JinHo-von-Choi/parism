import { describe, it, expect } from "vitest";
import type { ResponseEnvelope, StdoutField, DiffField } from "../../src/types/envelope.js";


describe("ResponseEnvelope", () => {
  it("성공 응답 구조가 올바르게 구성된다", () => {
    const envelope: ResponseEnvelope = {
      ok:          true,
      exitCode:    0,
      cmd:         "ls",
      args:        ["-la"],
      cwd:         "/home/user",
      duration_ms: 12,
      stdout: {
        raw:    "total 8\ndrwxr-xr-x 2 user group 4096 Mar 06 09:23 src",
        parsed: null,
      },
      stderr: {
        raw:    "",
        parsed: null,
      },
      diff: null,
    };

    expect(envelope.ok).toBe(true);
    expect(envelope.exitCode).toBe(0);
    expect(envelope.stdout.raw).toContain("src");
    expect(envelope.diff).toBeNull();
  });

  it("실패 응답은 ok=false, exitCode!=0 이다", () => {
    const envelope: ResponseEnvelope = {
      ok:          false,
      exitCode:    1,
      cmd:         "ls",
      args:        ["/nonexistent"],
      cwd:         "/home/user",
      duration_ms: 5,
      stdout: { raw: "", parsed: null },
      stderr: { raw: "ls: cannot access '/nonexistent': No such file or directory", parsed: null },
      diff:   null,
    };

    expect(envelope.ok).toBe(false);
    expect(envelope.exitCode).toBe(1);
    expect(envelope.stderr.raw).toContain("No such file");
  });

  it("truncated=true이면 잘린 출력임을 나타낸다", () => {
    const envelope: ResponseEnvelope = {
      ok: true, exitCode: 0, cmd: "ls", args: [], cwd: "/tmp",
      duration_ms: 1,
      stdout: { raw: "...[truncated]", parsed: null },
      stderr: { raw: "", parsed: null },
      diff: null,
      truncated: true,
    };
    expect(envelope.truncated).toBe(true);
  });

  it("truncated 필드 미설정 시 undefined (하위 호환)", () => {
    const envelope: ResponseEnvelope = {
      ok: true, exitCode: 0, cmd: "ls", args: [], cwd: "/tmp",
      duration_ms: 1,
      stdout: { raw: "", parsed: null },
      stderr: { raw: "", parsed: null },
      diff: null,
    };
    expect(envelope.truncated).toBeUndefined();
  });

  it("page_info 필드를 포함한 페이지 응답 구조가 올바르다", () => {
    const envelope: ResponseEnvelope = {
      ok: true, exitCode: 0, cmd: "ps", args: ["aux"], cwd: "/tmp",
      duration_ms: 10,
      stdout: { raw: "line1\nline2\n", parsed: null },
      stderr: { raw: "", parsed: null },
      diff: null,
      page_info: { page: 0, page_size: 50, total_lines: 200, has_next: true },
    };
    expect(envelope.page_info?.has_next).toBe(true);
    expect(envelope.page_info?.total_lines).toBe(200);
  });
});
