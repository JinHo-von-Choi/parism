/**
 * run_paged 단일 실행 캐시.
 * 같은 (cmd, args, cwd, includeDiff) 조회의 후속 페이지가 명령을 다시 실행하지 않도록
 * 성공한 첫 실행 결과를 짧게 보관한다. 항목 수와 바이트 합계 모두에 상한을 둔다.
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 */

import type { ResponseEnvelope } from "../types/envelope.js";

export interface CachedOutput {
  envelope:  ResponseEnvelope;
  createdAt: number;
}

/** 항목이 차지하는 대략의 바이트 수. stdout과 stderr 원문의 UTF-8 길이 합이다. */
function entryBytes(value: CachedOutput): number {
  return Buffer.byteLength(value.envelope.stdout.raw, "utf8") + Buffer.byteLength(value.envelope.stderr.raw, "utf8");
}

export class PageCache {
  private readonly entries = new Map<string, CachedOutput>();
  private readonly sizes   = new Map<string, number>();
  private totalBytes       = 0;

  constructor(
    private readonly ttlMs:      number,
    private readonly maxEntries: number,
    private readonly maxBytes:   number,
  ) {}

  /** TTL 안의 항목을 돌려주고 최근 사용으로 갱신한다. 만료된 항목은 제거한다. */
  get(key: string, now: number = Date.now()): CachedOutput | undefined {
    const hit = this.entries.get(key);
    if (hit === undefined) return undefined;
    if (now - hit.createdAt > this.ttlMs) {
      this.remove(key);
      return undefined;
    }
    this.entries.delete(key);
    this.entries.set(key, hit);
    return hit;
  }

  /**
   * 항목을 저장한다. 항목 하나가 maxBytes를 넘으면 저장하지 않는다.
   * maxEntries 또는 maxBytes를 넘으면 가장 오래 쓰지 않은 항목부터 제거한다.
   */
  set(key: string, value: CachedOutput, now: number = Date.now()): void {
    this.purgeExpired(now);
    this.remove(key);
    const bytes = entryBytes(value);
    if (bytes > this.maxBytes) return;
    this.entries.set(key, value);
    this.sizes.set(key, bytes);
    this.totalBytes += bytes;
    while (this.entries.size > this.maxEntries || this.totalBytes > this.maxBytes) {
      this.remove(this.entries.keys().next().value as string);
    }
  }

  /** 저장된 항목의 바이트 합계 */
  get bytes(): number {
    return this.totalBytes;
  }

  private remove(key: string): void {
    if (!this.entries.delete(key)) return;
    this.totalBytes -= this.sizes.get(key) ?? 0;
    this.sizes.delete(key);
  }

  private purgeExpired(now: number): void {
    for (const [k, v] of this.entries) {
      if (now - v.createdAt > this.ttlMs) this.remove(k);
    }
  }
}
