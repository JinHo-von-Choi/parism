/**
 * 파이프라인 단계별 성능 수집 유틸리티.
 * config.telemetry.enabled=true일 때만 ResponseEnvelope에 포함된다.
 */

import type { TelemetryField } from "../types/envelope.js";

/**
 * 파이프라인 실행 중 각 단계의 타이밍을 수집하는 스톱워치.
 */
export class PipelineTimer {
  private readonly marks = new Map<string, number>();
  private readonly start = performance.now();
  private rawBytes = 0;

  /** 지정한 단계의 시작 시각을 기록한다. */
  markStart(stage: string): void {
    this.marks.set(`${stage}_start`, performance.now());
  }

  /** 지정한 단계의 종료 시각을 기록하고 경과 밀리초를 반환한다. */
  markEnd(stage: string): number {
    const startKey = `${stage}_start`;
    const s = this.marks.get(startKey);
    if (s === undefined) return 0;
    const elapsed = performance.now() - s;
    this.marks.set(`${stage}_ms`, elapsed);
    return elapsed;
  }

  /** stdout raw 바이트 수를 기록한다. */
  setRawBytes(bytes: number): void {
    this.rawBytes = bytes;
  }

  /** 수집된 메트릭을 TelemetryField로 변환한다. */
  toField(): TelemetryField {
    const get = (stage: string) => Math.round((this.marks.get(`${stage}_ms`) ?? 0) * 100) / 100;
    return {
      guard_ms:  get("guard"),
      exec_ms:   get("exec"),
      parse_ms:  get("parse"),
      redact_ms: get("redact"),
      total_ms:  Math.round((performance.now() - this.start) * 100) / 100,
      raw_bytes: this.rawBytes,
    };
  }
}
