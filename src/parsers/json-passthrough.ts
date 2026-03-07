/**
 * stdout이 네이티브 JSON 출력인지 감지하고, 맞으면 파싱 결과를 반환한다.
 * 감지 조건: trim 후 { 또는 [ 로 시작하고 전체가 유효한 JSON일 것.
 */
export function tryParseNativeJson(raw: string): unknown | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  const first = trimmed[0];
  if (first !== "{" && first !== "[") return null;

  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}
