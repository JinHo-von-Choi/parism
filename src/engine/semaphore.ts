/**
 * 동시 실행 수 상한.
 * 한도까지는 바로 실행하고, 넘는 작업은 들어온 순서대로 대기시킨다.
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 */
export class Semaphore {
  private active = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(private readonly limit: number) {
    if (!Number.isInteger(limit) || limit < 1) {
      throw new RangeError(`Semaphore limit must be a positive integer: ${limit}`);
    }
  }

  /** 자리를 얻어 task를 실행하고, 성공·실패와 관계없이 자리를 돌려준다. */
  async run<T>(task: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await task();
    } finally {
      this.release();
    }
  }

  private acquire(): Promise<void> {
    if (this.active < this.limit) {
      this.active++;
      return Promise.resolve();
    }
    return new Promise(resolve => this.waiters.push(resolve));
  }

  /** 대기 중인 작업이 있으면 자리를 그대로 넘기고, 없으면 자리를 비운다. */
  private release(): void {
    const next = this.waiters.shift();
    if (next) next();
    else      this.active--;
  }
}
