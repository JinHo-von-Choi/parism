/**
 * 사용 통계 기록.
 *
 * run 한 번, 가드 거절 한 번, 재질의 한 번, Stop 훅 판정 한 번마다 줄 하나를 남긴다.
 * `parism stats`와 `parism doctor`가 이 기록을 읽는다.
 *
 * 남기는 것: 시각, 종류, 명령 이름, 결과 분류, 바이트 수와 토큰 추정치, 가린 구간 수.
 * 남기지 않는 것: 인자, 출력 본문, 경로. 인자에는 비밀이 들어 있을 수 있다.
 *
 * 작성자: 최진호
 * 작성일: 2026-11-12
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

export type StatsKind = "run" | "guard_block" | "shell_reject" | "query" | "stop_block" | "stop_pass" | "hook_rewrite" | "hook_block";

export interface StatsEvent {
  /** ISO 시각 */
  t:     string;
  kind:  StatsKind;
  cmd?:  string;
  /** run: parsed | text | exec_failed | parse_failed. guard_block: 가드 사유. shell_reject: 거절한 연산자 */
  outcome?: string;
  /** 명령이 실제로 낸 표준 출력과 표준 오류의 바이트 수 */
  raw_bytes?:       number;
  /** 응답 본문(JSON)의 바이트 수 */
  delivered_bytes?: number;
  /** 원문을 그대로 냈다면 들었을 토큰 추정치 */
  raw_tokens?:       number;
  /** 실제로 낸 응답의 토큰 추정치 */
  delivered_tokens?: number;
  /** 시크릿 리댁션이 가린 구간 수 */
  redactions?:   number;
  /** 결과 보관함에 자동으로 넣었으면 true */
  auto_retained?: true;
  /** query: 재실행 없이 보관 결과를 다시 읽었으면 true */
  hit?: boolean;
  /** 파이프를 행 모드나 글자 모드로 처리했으면 그 모드 */
  pipe?: "rows" | "text";
}

/** 기록 수가 이 정도 늘 때마다 상한을 검사한다. 매번 파일 전체를 읽지 않기 위해서다. */
const PRUNE_EVERY = 500;

export class StatsLog {
  readonly file: string;
  private appended = 0;

  constructor(dir: string, private readonly maxEntries: number) {
    this.file = path.join(dir, "events.jsonl");
  }

  /** 기록 하나를 남긴다. 실패해도 명령 결과에는 영향을 주지 않는다. */
  record(event: Omit<StatsEvent, "t">): void {
    try {
      mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
      appendFileSync(this.file, JSON.stringify({ t: new Date().toISOString(), ...event }) + "\n", { mode: 0o600 });
      if (++this.appended % PRUNE_EVERY === 0) this.prune();
    } catch (err) {
      process.stderr.write(`[parism] WARNING: stats event was not written: ${(err as Error).message}\n`);
    }
  }

  /** 기록을 오래된 순서로 읽는다. since(ms epoch)를 주면 그 뒤의 기록만이다. */
  read(since?: number): StatsEvent[] {
    if (!existsSync(this.file)) return [];
    const out: StatsEvent[] = [];
    for (const line of readFileSync(this.file, "utf8").split("\n")) {
      if (line.trim() === "") continue;
      try {
        const event = JSON.parse(line) as StatsEvent;
        if (typeof event.t !== "string" || typeof event.kind !== "string") continue;
        if (since !== undefined && Date.parse(event.t) < since) continue;
        out.push(event);
      } catch {
        /** 쓰다 끊긴 줄은 기록이 아니다. */
      }
    }
    return out;
  }

  /** 상한을 넘은 오래된 기록을 지운다 */
  prune(): void {
    if (!existsSync(this.file) || statSync(this.file).size === 0) return;
    const lines = readFileSync(this.file, "utf8").split("\n").filter(l => l.trim() !== "");
    if (lines.length <= this.maxEntries) return;
    writeFileSync(this.file, lines.slice(lines.length - this.maxEntries).join("\n") + "\n", { mode: 0o600 });
  }
}
