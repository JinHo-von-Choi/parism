/**
 * 경로 정규화 유틸리티.
 *
 * 설정 로더(config), 가드(engine), 영수증(engine)이 함께 쓴다.
 * 어느 계층에도 속하지 않는 순수 함수만 둔다.
 *
 * 작성자: 최진호
 * 작성일: 2026-11-12
 */

import path             from "node:path";
import { realpathSync } from "node:fs";

/**
 * 존재하는 가장 가까운 상위 경로까지 심볼릭 링크를 해석하고 나머지 경로를 덧붙인다.
 * 아직 없는 경로도 실제 위치를 기준으로 비교할 수 있게 한다.
 */
export function resolveRealUncached(absPath: string): string {
  let head = absPath;
  const tail: string[] = [];
  for (;;) {
    try {
      return path.join(realpathSync.native(head), ...tail.reverse());
    } catch {
      const parent = path.dirname(head);
      if (parent === head) return absPath;
      tail.push(path.basename(head));
      head = parent;
    }
  }
}

/**
 * 경로를 절대경로로 만든 뒤 존재하는 가장 가까운 상위 경로까지 심볼릭 링크를 해석한 실경로를 돌려준다.
 */
export function realPathOf(inputPath: string): string {
  return resolveRealUncached(path.resolve(inputPath));
}
