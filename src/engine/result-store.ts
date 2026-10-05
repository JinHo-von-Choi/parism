/**
 * 세션 결과 저장소.
 *
 * 근거 조회(explain_result)와 이어 읽기(fetch_result)는 재실행 없이 저장된 결과를 다시 본다.
 * 저장은 서버 인스턴스와 세션에 묶인 메모리에만 있고 디스크에 남지 않는다.
 * 보관하지 못한 결과를 조회하려 하면 자동 재실행하지 않고 만료/미보관 오류를 돌려준다.
 *
 * 작성자: 최진호
 * 작성일: 2026-10-05
 */

import type { FieldEvidence, Review } from "./evidence.js";
import type { Fingerprint } from "./compare/fingerprint.js";

/** 저장 한도와 TTL. 값은 시작점이며 실측 뒤 조정한다(계획서 6장). */
export interface ResultStoreLimits {
  /** 결과 하나가 가질 수 있는 최대 바이트 */
  maxBytesPerResult:  number;
  /** 세션 전체가 가질 수 있는 최대 바이트 */
  maxBytesTotal:      number;
  /** 보관할 최대 결과 개수 */
  maxEntries:         number;
  /** 보관 기간(ms). 지나가면 만료된다 */
  ttlMs:              number;
}

export const DEFAULT_RESULT_STORE_LIMITS: ResultStoreLimits = {
  maxBytesPerResult:  2 * 1024 * 1024,
  maxBytesTotal:      32 * 1024 * 1024,
  maxEntries:         16,
  ttlMs:              60_000,
};

/** 저장된 결과 한 건 */
export interface StoredResult {
  resultId:   string;
  createdAt:  number;
  /** 사용자에게 보여줄 정규 원문(마스킹 후). 근거 바이트 오프셋의 기준이다 */
  stdout:     string;
  stderr:     string;
  parsed:     unknown;
  /** JSON Pointer -> 근거 */
  evidence:   Readonly<Record<string, FieldEvidence[]>>;
  review:     Review;
  bytes:      number;
  /** 결과가 만들어질 때의 실행 대상 */
  cmd:        string;
  args:       string[];
  cwd:        string;
  /** 비교 가능 여부를 판단할 근거. 결과 안에는 인증서가 아니라 판단 재료다 */
  fingerprint?: Fingerprint;
}

/** 조회 실패 사유 */
export type StoreMissReason = "unknown_id" | "expired" | "evicted" | "not_retained";

export type StoreLookup =
  | { found: true;  result: StoredResult; age_ms: number }
  | { found: false; reason: StoreMissReason; message: string };

/**
 * TTL과 LRU를 함께 쓰는 인메모리 결과 저장소.
 * 보관하지 못했을 때도 그 사실을 알려야 continuation 을 약속하지 않는다.
 */
export class ResultStore {
  private readonly entries  = new Map<string, StoredResult>();
  private totalBytes        = 0;
  /** 만료와 퇴출이 일어난 결과의 최근 사유. 같은 id 를 다시 물어도 자동으로 재실행하지 않는다. */
  private readonly misses   = new Map<string, { reason: StoreMissReason; at: number }>();

  constructor(private readonly limits: ResultStoreLimits = DEFAULT_RESULT_STORE_LIMITS) {}

  /** 현재 보관 중인 결과 수 */
  get size(): number { return this.entries.size; }

  /** 현재 보관 중인 바이트 합계 */
  get bytes(): number { return this.totalBytes; }

  /**
   * 결과를 보관한다. 한도를 넘는 결과는 보관하지 않고 retained=false 사유를 돌려준다.
   * 가장 오래 쓰이지 않은 것부터 비운 뒤에도 안 들어가면 그 결과만 포기한다.
   */
  put(result: StoredResult): { retained: boolean; reason?: string } {
    this.evictExpired();
    this.drop(result.resultId);

    if (result.bytes > this.limits.maxBytesPerResult) {
      this.misses.set(result.resultId, { reason: "evicted", at: Date.now() });
      return { retained: false, reason: `result is ${result.bytes} bytes, over the ${this.limits.maxBytesPerResult} byte per-result limit` };
    }
    while (
      (this.entries.size >= this.limits.maxEntries || this.totalBytes + result.bytes > this.limits.maxBytesTotal)
      && this.entries.size > 0
    ) {
      this.dropOldest();
    }
    if (this.entries.size >= this.limits.maxEntries || this.totalBytes + result.bytes > this.limits.maxBytesTotal) {
      this.misses.set(result.resultId, { reason: "evicted", at: Date.now() });
      return { retained: false, reason: "result store is full" };
    }

    this.entries.set(result.resultId, result);
    this.totalBytes += result.bytes;
    this.misses.delete(result.resultId);
    return { retained: true };
  }

  /** 결과 하나를 찾는다. 없으면 왜 없었는지(만료·퇴출·미보관)를 함께 알린다. */
  get(resultId: string): StoreLookup {
    const found = this.entries.get(resultId);
    if (found) {
      const age = Date.now() - found.createdAt;
      /** 최근에 쓴 결과의 순서를 뒤로 옮겨 LRU 를 지킨다 */
      this.entries.delete(resultId);
      this.entries.set(resultId, found);
      if (age > this.limits.ttlMs) {
        this.drop(resultId);
        this.misses.set(resultId, { reason: "expired", at: Date.now() });
        return {
          found:   false,
          reason:  "expired",
          message: `result '${resultId}' expired after ${this.limits.ttlMs} ms; it is not re-executed automatically`,
        };
      }
      return { found: true, result: found, age_ms: age };
    }
    const miss = this.misses.get(resultId);
    if (miss) {
      return {
        found:   false,
        reason:  miss.reason,
        message: `result '${resultId}' is no longer retained (${miss.reason}); it is not re-executed automatically`,
      };
    }
    return {
      found:   false,
      reason:  "unknown_id",
      message: `result '${resultId}' is not known to this session; it is not re-executed automatically`,
    };
  }

  /** 저장소를 비운다 */
  clear(): void {
    this.entries.clear();
    this.misses.clear();
    this.totalBytes = 0;
  }

  /** 다 쓴 결과를 쫓아내고 쓰기 순서도 갱신한다 */
  touch(resultId: string): void {
    const found = this.entries.get(resultId);
    if (!found) return;
    this.entries.delete(resultId);
    this.entries.set(resultId, found);
  }

  private drop(resultId: string): void {
    const found = this.entries.get(resultId);
    if (!found) return;
    this.entries.delete(resultId);
    this.totalBytes -= found.bytes;
  }

  /**
   * 요청에서 보관하지 않기로 한 id 를 '보관하지 않았다'로 기록한다.
   * result_id 는 이미 사용자에게 돌아갔으므로, 나중에 그 id 로 조회하면
   * 모르는 id 와 구분되는 사유를 받아야 한다 — '어디로 갔나'를 알 수 있어야 한다.
   */
  markNotRetained(resultId: string): void {
    if (this.entries.has(resultId)) return;
    this.misses.set(resultId, { reason: "not_retained", at: Date.now() });
  }

  private dropOldest(): void {
    const oldest = this.entries.keys().next();
    if (oldest.done) return;
    const id = oldest.value;
    this.drop(id);
    this.misses.set(id, { reason: "evicted", at: Date.now() });
  }

  private evictExpired(): void {
    const now = Date.now();
    for (const [id, entry] of [...this.entries]) {
      if (now - entry.createdAt > this.limits.ttlMs) {
        this.drop(id);
        this.misses.set(id, { reason: "expired", at: now });
      }
    }
  }
}

/** JSON Pointer 로 구조를 따라간다. 배열은 인덱스로, 객체는 키로. 없으면 undefined. */
export function resolvePointer(root: unknown, pointer: string): unknown {
  if (pointer === "" || pointer === "#") return root;
  const path = pointer.startsWith("#") ? pointer.slice(1) : pointer;
  if (!path.startsWith("/")) return undefined;
  let current: unknown = root;
  for (const rawSegment of path.slice(1).split("/")) {
    const segment = rawSegment.replace(/~1/g, "/").replace(/~0/g, "~");
    if (Array.isArray(current)) {
      const index = Number(segment);
      if (!Number.isInteger(index)) return undefined;
      current = current[index];
      continue;
    }
    if (typeof current === "object" && current !== null) {
      current = (current as Record<string, unknown>)[segment];
      continue;
    }
    return undefined;
  }
  return current;
}

