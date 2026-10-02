/**
 * run_paged 단일 실행 캐시.
 * 같은 (cmd, args, cwd) 조회의 후속 페이지가 명령을 다시 실행하지 않도록 첫 실행 결과를 짧게 보관한다.
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 */

import type { ResponseEnvelope } from "../types/envelope.js";

export interface CachedOutput {
  envelope:  ResponseEnvelope;
  createdAt: number;
}

export class PageCache {
  private readonly entries = new Map<string, CachedOutput>();

  constructor(
    private readonly ttlMs:      number,
    private readonly maxEntries: number,
  ) {}

  /** TTL 안의 항목을 돌려주고 최근 사용으로 갱신한다. 만료된 항목은 제거한다. */
  get(key: string, now: number = Date.now()): CachedOutput | undefined {
    const hit = this.entries.get(key);
    if (hit === undefined) return undefined;
    if (now - hit.createdAt > this.ttlMs) {
      this.entries.delete(key);
      return undefined;
    }
    this.entries.delete(key);
    this.entries.set(key, hit);
    return hit;
  }

  /** 항목을 저장하고 maxEntries 를 넘으면 가장 오래 쓰지 않은 항목부터 제거한다. */
  set(key: string, value: CachedOutput, now: number = Date.now()): void {
    this.purgeExpired(now);
    this.entries.delete(key);
    this.entries.set(key, value);
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value as string;
      this.entries.delete(oldest);
    }
  }

  private purgeExpired(now: number): void {
    for (const [k, v] of this.entries) {
      if (now - v.createdAt > this.ttlMs) this.entries.delete(k);
    }
  }
}
