/**
 * 마스킹과 오프셋 대응.
 *
 * 근거의 바이트 구간은 사용자에게 보여줄 정규 원문(마스킹 후) 기준이어야 한다.
 * 그런데 마스킹은 문자열 길이를 바꾸므로, 파싱 시점의 위치를 그대로 쓰면 근거가 어긋난다.
 * 이 모듈은 마스킹 전후의 위치를 정확히 대응시켜 근거가 가리키는 내용을 지킨다.
 *
 * 파싱에 쓰는 원문은 건드리지 않는다. 마스킹은 파서 실행 뒤 서버 레이어에서만 일어난다.
 *
 * 작성자: 최진호
 * 작성일: 2026-10-05
 */

export const REDACTED_TOKEN = "[REDACTED]";

/** 마스킹으로 바뀐 구간 한 개. 마스킹 전 좌표계 기준이다. */
export interface MaskedRange {
  start:      number;
  end:        number;
  /** 마스킹 후 이 구간이 차지하는 길이 */
  maskedLength: number;
}

/** 마스킹 결과와 좌표 대응표 */
export interface MaskResult {
  text:   string;
  ranges: MaskedRange[];
  /** 실제로 바뀐 구간 수. 0 이면 마스킹이 없었다 */
  count:  number;
}

/** 원래 문자열에서 바뀐 구간을 찾아 치환 결과를 만든다. */
function applyPattern(text: string, pattern: string, ranges: MaskedRange[]): string {
  let re: RegExp;
  try {
    re = new RegExp(pattern, "g");
  } catch {
    /** 유효하지 않은 패턴은 건너뛴다. 기동 시 validatePatterns 가 미리 경고한다. */
    return text;
  }
  let out     = "";
  let last    = 0;
  let changed = false;
  for (let m = re.exec(text); m !== null; m = re.exec(text)) {
    const start = m.index;
    const end   = start + m[0].length;
    /** 빈 일치는 위치를 안 움직이므로 건너뛴다(무한 진행 방지) */
    if (end === start) { re.lastIndex++; continue; }
    out += text.slice(last, start) + REDACTED_TOKEN;
    ranges.push({ start, end, maskedLength: REDACTED_TOKEN.length });
    last    = end;
    changed = true;
  }
  if (!changed) return text;
  return out + text.slice(last);
}

/**
 * 문자열을 마스킹하고, 바뀐 구간을 **마스킹 전 좌표계**로 돌려준다.
 * 패턴을 순서대로 적용할 때 생기는 좌표 이동을 되돌려 놓는 것이 이 함수의 핵심이다.
 */
export function maskWithRanges(text: string, patterns: string[]): MaskResult {
  if (!text || patterns.length === 0) return { text, ranges: [], count: 0 };

  /** 각 단계의 구간을 그 단계 직전 좌표계로 저장한다 */
  const stages: MaskedRange[][] = [];
  let current = text;
  for (const pattern of patterns) {
    const step: MaskedRange[] = [];
    const next = applyPattern(current, pattern, step);
    if (next !== current) {
      stages.push(step);
      current = next;
    }
  }
  if (stages.length === 0) return { text, ranges: [], count: 0 };

  /**
   * 뒤 단계의 구간을 **최초 좌표계**로 옮긴다.
   *
   * k 번째 단계에서 발견된 구간은 **k-1 단계까지 치환된 문자열의 좌표**다.
   * 그 문자열은 최초 문자열보다 짧으므로, 같은 내용이 최초 좌표에서는 **더 뒤**에 있다.
   *   최초 위치 = 단계 좌표 + (앞선 치환이 줄인 만큼)
   *
   * ## 여기서 두 가지를 반드시 지켜야 한다
   *
   * **1) 같은 단계의 구간에는 감소량을 적용하지 않는다.**
   * 같은 단계의 모든 구간은 **같은 문자열**에서 나온 것이다. 앞 구간을 치환한 **뒤에**
   * 뒤 구간을 찾은 것이 아니므로, 앞 구간의 길이 감소는 뒤 구간의 좌표에 반영되어 있지 않다.
   * 반영하면 구간이 **앞당겨진다.**
   *
   * 실측(시크릿 두 개가 있는 출력):
   *   참 구간  `[282, 324)` — `ghp_CANARY…` 42글자
   *   잘못된 값 `[250, 292)` — 32글자 앞당겨져 앞 레코드의 끝, 개행,
   *            다음 레코드의 **상태 두 글자**까지 삼켰다. 그래서 그 레코드의 상태 근거가
   *            경로 한가운데를 가리켰다. 틀린 값이 아니라 근거가 없는 값이라 드러나지 않는다.
   *
   * **2) 감소량은 더한다.** 치환은 문자를 **줄였다**니 뒤 구간의 최초 좌표가 뒤로 밀린다.
   * 빼면 앞당겨진다.
   */
  type Placed = { range: MaskedRange; stage: number };
  const placed: Placed[] = [];
  const original: MaskedRange[] = [];

  for (let k = 0; k < stages.length; k++) {
    for (const range of stages[k]!) {
      /**
       * k 보다 앞선 단계의 구간만 이 구간의 좌표를 밀어 놓았다.
       * 그 구간들의 끝을 **k 단계 좌표로 되돌린 뒤에** 앞에 있는지 비교한다.
       */
      const earlierStages = placed.filter(p => p.stage < k);
      let shrink = 0;
      for (const p of earlierStages) {
        const pEndHere = p.range.end + shrinkOf(earlierStages, p);
        if (pEndHere <= range.start) shrink += (p.range.end - p.range.start) - p.range.maskedLength;
      }
      const start = range.start + shrink;
      const end   = range.end + shrink;
      /** 앞 단계에서 이미 가려진 구간이면 건너뛴다 */
      if (original.some(e => start < e.end && end > e.start)) continue;
      const entry: MaskedRange = { start, end, maskedLength: range.maskedLength };
      original.push(entry);
      placed.push({ range: entry, stage: k });
    }
  }

  original.sort((a, b) => a.start - b.start);
  return { text: current, ranges: original, count: original.length };
}

/**
 * `target` 보다 앞에 있는 구간들이 **줄인 글자 수**의 합.
 *
 * `all` 은 발견 순서(같은 단계 안에서는 오름차순)다. 단계가 순서대로 적용되므로
 * 먼저 발견된 구간이 항상 앞에 온다.
 */
function shrinkOf(all: readonly { range: MaskedRange }[], target: { range: MaskedRange }): number {
  let sum = 0;
  for (const p of all) {
    if (p === target) break;
    sum += (p.range.end - p.range.start) - p.range.maskedLength;
  }
  return sum;
}

/**
 * 마스킹 전 위치를 마스킹 후 위치로 옮긴다.
 * 가려진 구간 안의 위치는 그 구간의 치환 토큰 시작으로 보낸다(가려진 값을 가리키지 않는다).
 */
export function mapOffset(ranges: readonly MaskedRange[], offset: number): number {
  let delta = 0;
  for (const range of ranges) {
    if (offset < range.start) return offset + delta;
    if (offset < range.end) return range.start + delta;
    delta += range.maskedLength - (range.end - range.start);
  }
  return offset + delta;
}

/**
 * 마스킹 전 문자열 위치를 마스킹 후 위치 구간으로 옮긴다.
 * 가려진 구간에 걸치면 치환 토큰 범위를 가리킨다.
 */
export function mapRange(ranges: readonly MaskedRange[], start: number, end: number): { start: number; end: number } {
  /** 요청 구간 전체가 하나의 가려진 구간 안에 있으면 값은 사라졌다. 치환 토큰을 가리킨다. */
  const covering = ranges.find(r => start >= r.start && end <= r.end);
  if (covering) {
    const before = ranges.reduce(
      (sum, r) => (r.end <= covering.start ? sum + r.maskedLength - (r.end - r.start) : sum),
      0,
    );
    return { start: covering.start + before, end: covering.start + before + covering.maskedLength };
  }

  /** 일부만 겹치면, 겹친 만큼을 치환 토큰 길이로 바꿔 합친다. */
  let delta = 0;
  let shrink = 0;
  for (const range of ranges) {
    if (range.end <= start) {
      delta += range.maskedLength - (range.end - range.start);
      continue;
    }
    if (range.start >= end) break;
    const overlap = Math.min(end, range.end) - Math.max(start, range.start);
    shrink += range.maskedLength - overlap;
  }
  return { start: start + delta, end: end + delta + shrink };
}
