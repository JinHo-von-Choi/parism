/**
 * git이 따옴표로 감싸 출력하는 경로를 원래 경로로 되돌린다.
 * git은 ASCII 밖 바이트, 제어 문자, 큰따옴표, 역슬래시가 든 경로를 C 문자열 형식("n\303\251w.txt")으로 감싼다.
 * 따옴표로 감싸지 않은 경로는 그대로 돌려준다.
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
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

/** 경로 전체가 따옴표로 감싸여 있으면 풀어 돌려주고, 아니면 그대로 돌려준다. */
export function unquoteGitPath(text: string): string {
  const read = readQuotedToken(text, 0);
  return read && read.end === text.length ? read.value : text;
}
