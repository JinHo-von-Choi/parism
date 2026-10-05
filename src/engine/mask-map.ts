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
   * 뒤 단계의 구간을 최초 좌표계로 옮긴다.
   * 앞 단계에서 같은 길이로 치환된 구간은 겹치지 않으므로, 앞에서 누적된 치환량만큼만 빼면 된다.
   */
  const original: MaskedRange[] = [];
  for (const step of stages) {
    for (const range of step) {
      let delta = 0;
      for (const earlier of original) {
        if (earlier.start >= range.end) break;
        delta += earlier.maskedLength - (earlier.end - earlier.start);
      }
      const start = range.start + delta;
      const end   = range.end + delta;
      /** 앞 단계에서 이미 가려진 구간이면 건너뛴다 */
      if (original.some(earlier => start < earlier.end && end > earlier.start)) continue;
      original.push({ start, end, maskedLength: range.maskedLength });
    }
  }
  original.sort((a, b) => a.start - b.start);
  return { text: current, ranges: original, count: original.length };
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
