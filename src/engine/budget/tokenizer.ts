/**
 * 고정 토크나이저.
 *
 * 예산 약속은 특정 토크나이저로 센 수에 대해서만 성립한다. 어느 토크나이저로 셌는지 밝히지 않은
 * "토큰 절감"은 비교할 수 없는 숫자다. 그래서 ID 와 버전을 결과에 함께 싣는다.
 *
 * 여기에 들어가는 것은 고유한 근사다. BPE 와 같은 수는 아니며, 그 사실을 감추지 않는다.
 * 정확한 측정이 필요하면 `byte` 모드를 쓴다(문자 단위로 정확하다).
 *
 * 작성자: 최진호
 * 작성일: 2026-10-05
 */

/** 지원하는 토크나이저. 이름이 곧 식별자다. */
export type TokenizerId = "parism/approx" | "byte";

/** 토크나이저 버전. 규칙이 바뀌면 올린다. */
export const TOKENIZER_VERSION = "1.0.0";

/** 이 약속이 성립하는 범위. 전송·클라이언트·모델 내부 토큰은 포함하지 않는다. */
export const TOKENIZER_SCOPE = "parism-json-payload-only";

export interface TokenizerInfo {
  id:      TokenizerId;
  version: string;
  scope:   string;
  /** 근사 여부. false 면 문자 수가 곧 답이다 */
  exact:   boolean;
}

const INFO: Record<TokenizerId, TokenizerInfo> = {
  "parism/approx": { id: "parism/approx", version: TOKENIZER_VERSION, scope: TOKENIZER_SCOPE, exact: false },
  "byte":           { id: "byte",           version: TOKENIZER_VERSION, scope: TOKENIZER_SCOPE, exact: true },
};

export function isSupportedTokenizer(id: string): id is TokenizerId {
  return Object.hasOwn(INFO, id);
}

export function tokenizerInfo(id: TokenizerId = "parism/approx"): TokenizerInfo {
  return INFO[id];
}

/**
 * 고유한 근사 규칙.
 *   - 알파벳·숫자·밑줄 연속 구간은 네 글자당 한 토큰으로 센다(긴 BPE 토큰을 흉내 낸다).
 *   - 그 밖의 문자는 공백이 아니면 한 글자당 한 토큰으로 센다(구두점·괄호·문자열 표시).
 *   - 공백은 새지 않는다(JSON 들여쓰기 한 번으로는 토큰이 늘지 않는다).
 *
 * 같은 문자열에는 언제나 같은 수를 낸다. 입력에 무관하게 결정적이다.
 */
export function countTokens(text: string, id: TokenizerId = "parism/approx"): number {
  if (id === "byte") return Buffer.byteLength(text, "utf8");
  if (text === "") return 0;

  let total    = 0;
  let wordLen  = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    const isWord = (code >= 48 && code <= 57) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122) || code === 95;
    if (isWord) { wordLen++; continue; }
    if (wordLen > 0) { total += Math.ceil(wordLen / 4); wordLen = 0; }
    if (code !== 32 && code !== 9 && code !== 10 && code !== 13) total++;
  }
  if (wordLen > 0) total += Math.ceil(wordLen / 4);
  return total;
}

/** JSON 을 직렬화해 센다. 예산은 '사용자에게 나가는 payload' 에 대한 약속이다. */
export function countJsonTokens(value: unknown, id: TokenizerId = "parism/approx"): number {
  const text = JSON.stringify(value, null, 2);
  return text === undefined ? 0 : countTokens(text, id);
}
