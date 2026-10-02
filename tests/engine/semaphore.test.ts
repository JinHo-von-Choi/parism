import { describe, it, expect } from "vitest";
import { Semaphore } from "../../src/engine/semaphore.js";

/** 동시에 실행 중인 작업 수의 최댓값을 기록하는 작업 묶음을 만든다. */
function tracker() {
  let active = 0;
  let peak   = 0;
  const task = async (ms: number): Promise<number> => {
    active++;
    peak = Math.max(peak, active);
    await new Promise(res => setTimeout(res, ms));
    active--;
    return ms;
  };
  return { task, peak: () => peak };
}

describe("Semaphore", () => {
  it("동시 실행 수를 한도 이하로 유지하고 모든 작업을 끝낸다", async () => {
    const sem = new Semaphore(4);
    const t   = tracker();
    const out = await Promise.all(Array.from({ length: 10 }, (_, i) => sem.run(() => t.task(10 + i))));
    expect(t.peak()).toBeLessThanOrEqual(4);
    expect(t.peak()).toBe(4);
    expect(out).toHaveLength(10);
  });

  it("작업이 실패해도 자리를 돌려준다", async () => {
    const sem = new Semaphore(1);
    await expect(sem.run(async () => { throw new Error("boom"); })).rejects.toThrow("boom");
    await expect(sem.run(async () => "next")).resolves.toBe("next");
  });

  it("대기 중인 작업은 들어온 순서대로 실행한다", async () => {
    const sem   = new Semaphore(1);
    const order: number[] = [];
    await Promise.all([1, 2, 3].map(n => sem.run(async () => { order.push(n); })));
    expect(order).toEqual([1, 2, 3]);
  });

  it("한도는 1 이상 정수여야 한다", () => {
    expect(() => new Semaphore(0)).toThrow(RangeError);
    expect(() => new Semaphore(1.5)).toThrow(RangeError);
  });
});
