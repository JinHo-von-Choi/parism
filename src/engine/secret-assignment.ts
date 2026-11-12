/**
 * 이름이 비밀을 뜻하는 대입(DB_PASSWORD=..., "api_key": "...", token: ...)의 값 구간을 찾는 규칙.
 *
 * 정규식으로 쓰면 이름은 남기고 값만 가리려면 lookbehind가 필요하다. lookbehind는 Rust 엔진이 받지 않아
 * 역추적 엔진으로 되돌아가고, 긴 식별자에서 시간이 이차 이상으로 늘어난다. 그래서 낱말을 indexOf로 찾고
 * 앞뒤를 한 번씩만 훑는 선형 스캐너로 둔다.
 *
 * 리댁션 패턴 목록에는 SECRET_ASSIGNMENT_RULE 문자열로 넣는다. 이 문자열을 만나면 정규식 대신 이 스캐너를 쓴다.
 *
 * 작성자: 최진호
 * 작성일: 2026-11-12
 */

/** 리댁션 패턴 목록에서 이 규칙을 가리키는 이름 */
export const SECRET_ASSIGNMENT_RULE = "<secret-assignment>";

const KEYWORDS = ["password", "passwd", "secret", "token", "apikey", "api_key", "api-key", "credential", "private_key"];

const IDENT    = /[A-Za-z0-9_.-]/;
const STOP     = /[\s"',;&]/;
const MIN_VALUE = 3;

/** ASCII 대문자만 소문자로 바꾼다. 길이가 바뀌지 않아 위치가 원문과 같다. */
function asciiLower(text: string): string {
  return text.replace(/[A-Z]/g, ch => String.fromCharCode(ch.charCodeAt(0) + 32));
}

/** 값 구간 목록(원문 좌표, 겹치지 않고 오름차순) */
export function secretAssignmentRanges(text: string): { start: number; end: number }[] {
  const lower = asciiLower(text);
  const found: { start: number; end: number }[] = [];
  for (const keyword of KEYWORDS) {
    let at = lower.indexOf(keyword);
    while (at >= 0) {
      let j = at + keyword.length;
      while (j < text.length && IDENT.test(text[j]!)) j++;
      /** 같은 식별자 안의 다음 낱말은 다시 보지 않는다. 그래야 긴 식별자에서도 전체가 선형이다. */
      const next = j;
      at = lower.indexOf(keyword, next);
      if (text[j] === "\"" || text[j] === "'") j++;
      while (text[j] === " " || text[j] === "\t") j++;
      if (text[j] !== "=" && text[j] !== ":") continue;
      /** URL(scheme://)의 콜론은 대입이 아니다 */
      if (text[j] === ":" && text[j + 1] === "/" && text[j + 2] === "/") continue;
      j++;
      while (text[j] === " " || text[j] === "\t") j++;
      if (text[j] === "\"" || text[j] === "'") j++;
      const start = j;
      while (j < text.length && !STOP.test(text[j]!)) j++;
      /** 값 안에 같은 낱말이 있어도 다시 훑지 않는다. */
      if (j > next) at = lower.indexOf(keyword, j);
      if (j - start < MIN_VALUE || text.slice(start, j) === "[REDACTED]") continue;
      found.push({ start, end: j });
    }
  }
  found.sort((a, b) => a.start - b.start);
  const merged: { start: number; end: number }[] = [];
  for (const r of found) {
    const last = merged[merged.length - 1];
    if (last && r.start < last.end) last.end = Math.max(last.end, r.end);
    else merged.push({ ...r });
  }
  return merged;
}
