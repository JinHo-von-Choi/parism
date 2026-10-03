import { describe, it, expect } from "vitest";
import { OutcomeStats, PipelineTimer } from "../../src/engine/telemetry.js";

describe("PipelineTimer", () => {
  it("단계별 타이밍을 수집하여 TelemetryField로 변환한다", () => {
    const timer = new PipelineTimer();

    timer.markStart("guard");
    timer.markEnd("guard");

    timer.markStart("exec");
    timer.markEnd("exec");

    timer.markStart("parse");
    timer.markEnd("parse");

    timer.markStart("redact");
    timer.markEnd("redact");

    timer.setRawBytes(1024);

    const field = timer.toField();

    expect(typeof field.guard_ms).toBe("number");
    expect(typeof field.exec_ms).toBe("number");
    expect(typeof field.parse_ms).toBe("number");
    expect(typeof field.redact_ms).toBe("number");
    expect(typeof field.total_ms).toBe("number");
    expect(field.raw_bytes).toBe(1024);
    expect(field.total_ms).toBeGreaterThanOrEqual(0);
  });

  it("markStart 없이 markEnd를 호출하면 0을 반환한다", () => {
    const timer = new PipelineTimer();
    const elapsed = timer.markEnd("missing");
    expect(elapsed).toBe(0);

    const field = timer.toField();
    expect(field.guard_ms).toBe(0);
  });

  it("raw_bytes 기본값은 0이다", () => {
    const timer = new PipelineTimer();
    const field = timer.toField();
    expect(field.raw_bytes).toBe(0);
  });
});

describe("OutcomeStats", () => {
  it("명령과 결과별로 세고 guard와 exec 실패는 사유별로 묶는다", () => {
    const stats = new OutcomeStats(["ls", "git"]);
    stats.record("ls", "parsed");
    stats.record("ls", "parsed");
    stats.record("ls", "unsupported_format");
    stats.record("ls", "guard", "path_not_allowed");
    stats.record("git", "exec", "non_zero_exit");
    stats.record("git", "exec", "timeout");
    stats.record("git", "exec", "timeout");

    expect(stats.snapshot()).toEqual({
      ls:  { parsed: 2, unsupported_format: 1, guard: { path_not_allowed: 1 } },
      git: { exec: { non_zero_exit: 1, timeout: 2 } },
    });
    expect(stats.forCommand("ls")).toEqual({ parsed: 2, unsupported_format: 1, guard: { path_not_allowed: 1 } });
    expect(stats.forCommand("df")).toEqual({});
  });

  it("허용 목록 밖의 명령은 한 항목으로 모아 메모리를 묶는다", () => {
    const stats = new OutcomeStats(["ls"]);
    for (const cmd of ["rm", "mv", "x".repeat(1000), "__proto__"]) stats.record(cmd, "guard", "command_not_allowed");
    expect(stats.snapshot()).toEqual({ "(unlisted)": { guard: { command_not_allowed: 4 } } });
  });

  it("스냅숏은 내부 상태의 사본이다", () => {
    const stats = new OutcomeStats(["ls"]);
    stats.record("ls", "parsed");
    const snap = stats.snapshot();
    stats.record("ls", "parsed");
    expect(snap.ls).toEqual({ parsed: 1 });
  });
});
