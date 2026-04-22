import { describe, it, expect } from "vitest";
import { PipelineTimer } from "../../src/engine/telemetry.js";

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
