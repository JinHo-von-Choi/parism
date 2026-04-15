/**
 * 출력 리댁션 모듈.
 * raw stdout/stderr 문자열에서 민감 정보를 [REDACTED]로 치환한다.
 * 파싱 전 원본은 건드리지 않는다 — 리댁션은 파서 실행 후 서버 레이어에서만 호출된다.
 */

export const DEFAULT_OUTPUT_REDACT_PATTERNS: string[] = [
  "sk-[A-Za-z0-9_-]{20,}",              // OpenAI/Anthropic API keys
  "ghp_[A-Za-z0-9]{30,}",              // GitHub Personal Access Token
  "gho_[A-Za-z0-9]{30,}",              // GitHub OAuth token
  "glpat-[A-Za-z0-9_-]{20,}",          // GitLab PAT
  "AKIA[0-9A-Z]{16}",                   // AWS Access Key ID
  "xox[baprs]-[A-Za-z0-9-]{10,}",      // Slack token
  "Bearer\\s+[A-Za-z0-9._-]+",         // generic Bearer header
];

/**
 * 주어진 패턴들로 문자열 안의 민감정보를 [REDACTED]로 치환한다.
 * 패턴은 RegExp 리터럴 문자열로 받아 RegExp("pattern", "g")로 컴파일한다.
 */
export function redact(text: string, patterns: string[]): string {
  if (!text || patterns.length === 0) return text;
  let result = text;
  for (const p of patterns) {
    try {
      const re = new RegExp(p, "g");
      result   = result.replace(re, "[REDACTED]");
    } catch {
      // Invalid regex — skip silently; the boot-time validator will warn
    }
  }
  return result;
}

/**
 * 패턴 목록을 컴파일 단계에서 검증하고, 유효하지 않은 패턴은 stderr 경고 후 제외한다.
 * 서버 기동 시 1회만 호출한다.
 */
export function validatePatterns(patterns: string[]): string[] {
  const valid: string[] = [];
  for (const p of patterns) {
    try {
      new RegExp(p);
      valid.push(p);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`[parism] invalid redact pattern '${p}': ${msg}\n`);
    }
  }
  return valid;
}
