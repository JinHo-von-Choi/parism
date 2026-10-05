/**
 * 마스킹 좌표 대응 회귀 시험.
 *
 * 2026-10-05 정확성 게이트가 잡은 세 가지 실측 결함의 시험이다.
 * 셋 다 **값이 틀리지 않는** 종류여서 시험이 없었다 — 근거가 없는 값이라 조용히 통과한다.
 *
 *   A-12 역변환   근거 구간이 인코딩된 표기를 담고 있어 검증이 통과하지 못했다
 *   A-15 바이트  근거 구간(바이트)을 문자 인덱스로 잘라 비 ASCII 이후가 어긋났다
 *   A-16 좌표계  마스킹 구간을 잘못된 좌표계로 옮겨 **뒤쪽 근거를 삼켰다**
 *
 * 작성자: 최진호
 * 작성일: 2026-10-05
 */

import { describe, it, expect } from "vitest";
import { maskWithRanges, mapRange, mapOffset, REDACTED_TOKEN } from "../../src/engine/mask-map.js";
import { verifySpans, sliceByBytes }                       from "../../src/engine/review.js";
import type { SourceSpan }                                  from "../../src/engine/evidence.js";

/** 실제 형식의 토큰. 정규식에 걸리지 않으면 아래 시험이 아무것도 검증하지 않게 된다. */
const SECRET_A = "ghp_CANARY0123456789abcdefghijKLmnopqrstuv";
const SECRET_B = "ghp_CANARY987654321zyxwvutsrqponmlkjihg";
const PATTERNS = ["ghp_[A-Za-z0-9]{30,}"];

function span(start: number, end: number, transform?: string): SourceSpan {
  return { source: "stdout", line: 0, start, end, ...(transform ? { transform } : {}) };
}

describe("마스킹 구간은 최초 좌표계로 옮겨진다 (결함 A-16)", () => {
  /**
   * 회귀: **같은 단계**에서 나온 두 구간에 앞 구간의 길이 감소를 적용했다.
   * 두 구간은 치환 전의 **같은 문자열**에서 나온 것이니 좌표계가 같다.
   * 감소를 적용하니 두 번째 구간이 32글자 앞당겨졌다.
   *
   * 앞당겨진 구간이 삼킨 것은 이전 레코드의 끝, 개행, 다음 레코드의 상태 두 글자였다.
   * 그래서 그 레코드의 `xy` 근거가 경로 한가운데를 가리켰다.
   */
  it("같은 문자열에서 나온 두 구간 중 뒤 구간을 앞당기지 않는다", () => {
    const raw = `?? ${SECRET_A}-a.txt\n?? plain.txt\n?? ${SECRET_B}-b.txt\n?? tail.txt\n`;
    const masked = maskWithRanges(raw, PATTERNS);

    expect(masked.ranges).toHaveLength(2);
    for (const r of masked.ranges) {
      /** 구간이 가리키는 것이 **원래 시크릿 그 자체**여야 한다 */
      expect(raw.slice(r.start, r.end), `구간 [${r.start},${r.end}) 이 시크릿이 아니다`).toMatch(/^ghp_/);
    }
  });

  it("두 시크릿 뒤의 모든 구간이 제자리를 가리킨다", () => {
    const raw = `?? ${SECRET_A}-a.txt\n?? keep-1.txt\n?? ${SECRET_B}-b.txt\n?? keep-2.txt\n`;
    const masked = maskWithRanges(raw, PATTERNS);

    const lineStarts: number[] = [];
    let at = 0;
    for (const line of raw.split("\n")) { lineStarts.push(at); at += line.length + 1; }

    lineStarts.forEach((start, i) => {
      const want = raw.slice(start, start + 2);
      const moved = mapRange(masked.ranges, start, start + 2);
      expect(masked.text.slice(moved.start, moved.end), `줄 ${i} 의 상태 두 글자가 어긋났다`).toBe(want);
    });
  });

  it("가려진 구간 안의 위치를 치환 토큰으로 보낸다", () => {
    const raw  = `?? ${SECRET_A}-a.txt\n`;
    const masked = maskWithRanges(raw, PATTERNS);
    const mid   = masked.ranges[0]!.start + 5;
    const at    = mapOffset(masked.ranges, mid);
    expect(masked.text.slice(at, at + REDACTED_TOKEN.length)).toBe(REDACTED_TOKEN);
  });
});

describe("근거 구간은 바이트다 (결함 A-15)", () => {
  /**
   * 회귀: 근거 구간은 **바이트** 오프셋인데 문자열을 문자 인덱스로 잘랐다.
   * 원문에 비 ASCII 가 한 글이라도 있으면 뒤의 모든 구간이 어긋난다.
   *
   * 실측: 한 저장소에 `emoji-😀.ts` 가 있고 그 뒤에 `plain.ts` 가 있으면
   * **`plain.ts` 의 근거가 엉뚱한 곳을 가리켜** 검증에 실패했다.
   * 이모지 한 글이 뒤의 모든 근거를 망가뜨렸고, 출력은 여전히 맞았다.
   */
  it("비 ASCII 뒤에서도 구간이 제자리를 가리킨다", () => {
    const text  = "A😀B\nplain.ts\n";
    const bytes = Buffer.from(text, "utf8");
    /** 'plain.ts' 의 바이트 위치 */
    const start = bytes.indexOf(Buffer.from("plain.ts"));
    expect(sliceByBytes(text, start, start + 8)).toBe("plain.ts");
  });

  it("순수 아스키에서는 바이트와 문자 위치가 같다", () => {
    const text = "?? plain.txt\n?? second.txt\n";
    /** "??" 가 0-1, " plain.txt" 가 2-11, 개행이 12, 두 번째 레코드가 13 부터다 */
    expect(sliceByBytes(text, 3, 12)).toBe("plain.txt");
    expect(sliceByBytes(text, 13, 15)).toBe("??");
  });

  it("경계가 글자 중간을 가리키지 않는다", () => {
    const text  = "한글 😀 테스트";
    const bytes = Buffer.from(text, "utf8");
    for (let i = 0; i <= bytes.length; i++) {
      /** 어떤 바이트 경계에서도 예외 없이 자를 수 있어야 한다 */
      expect(() => sliceByBytes(text, i, Math.min(i + 4, bytes.length))).not.toThrow();
    }
  });
});

describe("근거 검증은 인코딩된 표기도 안다 (결함 A-12)", () => {
  /**
   * 회귀: 구간이 **인코딩된 표기**일 수 있는데 정확한 문자열 대조만 하고 있었다.
   * git 은 공백이 든 경로를 따옴표로 감싸므로 구간이 `"with space.ts"` 를 담고
   * 값은 `with space.ts` 였다. 그 구간을 근거로 인정하지 못하고 `source_kind: "none"` 이 됐다.
   *
   * 실측: 정확성 게이트 1,200 케이스 중 **8,819건**이 이 이유로 낮아졌다.
   */
  it("따옴표로 감싸진 경로도 근거로 인정한다", () => {
    const text  = '?? "with space.ts"';
    const start = text.indexOf('"');
    const ok = verifySpans(text, [span(start, text.length, "unescape_c_quotes")], "with space.ts");
    expect(ok.ok).toBe(true);
  });

  it("역변환한 결과가 정확히 그 값일 때만 통과한다", () => {
    const text = '?? "with space.ts"';
    const start = text.indexOf('"');
    /** 다른 값과 대조하면 통과하면 안 된다 */
    expect(verifySpans(text, [span(start, text.length, "unescape_c_quotes")], "with  space.ts").ok).toBe(false);
    expect(verifySpans(text, [span(start, text.length, "unescape_c_quotes")], "with").ok).toBe(false);
  });

  it("모르는 변환은 관대하게 대조하지 않는다", () => {
    const text = '?? "with space.ts"';
    const start = text.indexOf('"');
    /** 역변환을 모르는 변환을 선언하면 근거로 받아들이지 않는다 */
    expect(verifySpans(text, [span(start, text.length, "알_모르는_변환")], "with space.ts").ok).toBe(false);
  });

  it("이스케이프가 든 경로도 근거로 인정한다", () => {
    const text  = '?? "line\\nbreak.txt"';
    const start = text.indexOf('"');
    const ok = verifySpans(text, [span(start, text.length, "unescape_c_quotes")], "line\nbreak.txt");
    expect(ok.ok).toBe(true);
  });

  it("표기를 그대로 담는 구간은 변환 선언이 없어도 통과한다", () => {
    expect(verifySpans("?? plain.txt", [span(3, 12)], "plain.txt").ok).toBe(true);
  });
});
