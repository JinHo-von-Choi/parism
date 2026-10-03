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

/** 사유별로 묶어 세는 결과 분류 */
export type GroupedOutcome = "guard" | "exec";

/** 파서 결과 분류. parsed는 내장 파서나 native JSON 폴백이 결과를 낸 경우다. */
export type ParseOutcome = "parsed" | "unsupported_format" | "unrecognized_output" | "parser_exception" | "schema_violation" | "parser_not_found";

/** 한 명령의 결과별 횟수. guard와 exec 실패는 사유별 횟수다. */
export interface CommandOutcomeCounts {
  parsed?:              number;
  unsupported_format?:  number;
  unrecognized_output?: number;
  parser_exception?:    number;
  schema_violation?:    number;
  parser_not_found?:    number;
  guard?:               Record<string, number>;
  exec?:                Record<string, number>;
}

/** 허용 목록 밖의 명령을 모으는 키. 임의의 명령 이름으로 항목이 늘지 않게 한다. */
export const UNLISTED_COMMAND = "(unlisted)";

/**
 * 프로세스 안의 명령별 결과 카운터. 외부로 보내거나 저장하지 않는다.
 * 키는 허용 목록의 명령 이름과 UNLISTED_COMMAND뿐이고 결과 키도 정해진 사유뿐이라 항목 수가 묶인다.
 */
export class OutcomeStats {
  private readonly known:  ReadonlySet<string>;
  private readonly counts = new Map<string, Map<string, number>>();

  constructor(knownCommands: Iterable<string>) {
    this.known = new Set(knownCommands);
  }

  /** 결과 하나를 센다. guard와 exec는 reason을 함께 준다. */
  record(cmd: string, outcome: ParseOutcome | GroupedOutcome, reason?: string): void {
    const key   = this.known.has(cmd) ? cmd : UNLISTED_COMMAND;
    const entry = reason === undefined ? outcome : `${outcome}:${reason}`;
    let   table = this.counts.get(key);
    if (table === undefined) {
      table = new Map();
      this.counts.set(key, table);
    }
    table.set(entry, (table.get(entry) ?? 0) + 1);
  }

  /** 한 명령의 횟수. 센 적이 없으면 빈 객체다. */
  forCommand(cmd: string): CommandOutcomeCounts {
    const table = this.counts.get(cmd);
    return table ? toCounts(table) : {};
  }

  /** 모든 명령의 횟수 사본. 명령 이름은 자기 속성 키로 둔다. */
  snapshot(): Record<string, CommandOutcomeCounts> {
    return Object.fromEntries([...this.counts].map(([cmd, table]) => [cmd, toCounts(table)]));
  }
}

/** "결과" 또는 "묶음:사유" 키의 횟수 표를 중첩 객체로 바꾼다. */
function toCounts(table: ReadonlyMap<string, number>): CommandOutcomeCounts {
  const out: Record<string, number | Record<string, number>> = {};
  for (const [entry, n] of table) {
    const sep = entry.indexOf(":");
    if (sep < 0) {
      out[entry] = n;
      continue;
    }
    const group  = entry.slice(0, sep);
    const bucket = (out[group] ??= {}) as Record<string, number>;
    bucket[entry.slice(sep + 1)] = n;
  }
  return out as CommandOutcomeCounts;
}
