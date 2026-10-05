/**
 * C 스타일 인용 표기의 역변환 — git 이 경로에 쓰는 형식이다.
 *
 * ## 왜 엔진에 두나
 *
 * 근거 검증을 하는 쪽(`review.ts`)이 **값이 인코딩된 표기일 수 있다**는 사실도 알아야 한다.
 * 원문 구간이 `"with space.ts"` 를 담고 있을 때 그 안에서 `with space.ts` 를 그대로 찾을 수
 * 없으므로, 정확한 문자열 대조만으로는 **증명할 수 있는 근거를 못 박습니다.**
 *
 * 엔진이 이 함수를 알아야 한다는 것은 분명하다. 문제는 이 코드가 git 파서 안에 있으면
 * `engine → parsers` 역전이 된다는 것이었다. 그래서 **순수 텍스트 코덱으로 분리해
 * 엔진에 두고, 파서가 엔진에서 가져가게** 했다. 파서는 이미 엔진에 의존하고 있으므로
 * (`engine/evidence.js`) 이쪽은 **정상 방향**이고 역전이 생기지 않는다.
 *
 * 이 모듈은 **의존이 하나도 없다.** 순수 텍스트 변환만 한다.
 *
 * 작성자: 최진호
 * 작성일: 2026-10-05
 */

const SIMPLE_ESCAPES: Readonly<Record<string, number>> = {
  a: 0x07, b: 0x08, f: 0x0c, n: 0x0a, r: 0x0d, t: 0x09, v: 0x0b, "\\": 0x5c, "\"": 0x22,
};

/** 여는 따옴표 위치에서 시작해 닫는 따옴표까지 읽는다. 닫는 따옴표 다음 위치를 함께 돌려준다. */
export function readQuotedToken(text: string, start: number): { value: string; end: number } | null {
  if (text[start] !== "\"") return null;
  const bytes: number[] = [];
  let i = start + 1;
  while (i < text.length) {
    const ch = text[i]!;
    if (ch === "\"") return { value: Buffer.from(bytes).toString("utf8"), end: i + 1 };
    if (ch !== "\\") {
      /**
       * **코드 포인트 단위로 읽는다.**
       *
       * `text[i]` 는 UTF-16 **코드 단위**다. 이모지처럼 서로게이트 쌍으로 표현되는 문자는
       * 코드 단위 두 개이므로, 한 단위씩 인코딩하면 각각 U+FFFD 로 바뀌어 원문이 훼손된다.
       * 실측: `?? "emoji-😀.ts"` → `emoji-��.ts` (한글 같은 BMP 문자는 멀쩡했다 —
       * BMP 는 코드 단위 하나가 곧 코드 포인트라 드러나지 않는다).
       */
      const point = text.codePointAt(i)!;
      const char  = String.fromCodePoint(point);
      bytes.push(...Buffer.from(char, "utf8"));
      i += char.length;
      continue;
    }
    const next = text[i + 1];
    if (next === undefined) return null;
    const octal = /^[0-7]{1,3}/.exec(text.slice(i + 1, i + 4));
    if (octal) {
      bytes.push(parseInt(octal[0], 8) & 0xff);
      i += 1 + octal[0].length;
    } else if (Object.hasOwn(SIMPLE_ESCAPES, next)) {
      bytes.push(SIMPLE_ESCAPES[next]!);
      i += 2;
    } else {
      return null;
    }
  }
  return null;
}

/**
 * 경로 전체가 따옴표로 감싸여 있으면 풀어 돌려주고, 아니면 그대로 돌려준다.
 *
 * **근거 검증의 역변환으로도 이 함수를 쓴다.** 대조는 항상 정확히 같을 때만 통과하므로
 * 느슨해지는 곳이 없다 — 되돌린 값이 정확히 그 값일 때만 근거로 인정한다.
 */
export function unquoteCQuoted(text: string): string {
  const read = readQuotedToken(text, 0);
  return read && read.end === text.length ? read.value : text;
}
