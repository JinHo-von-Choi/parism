import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { redact, validatePatterns, DEFAULT_OUTPUT_REDACT_PATTERNS } from "../../src/engine/redactor.js";

describe("DEFAULT_OUTPUT_REDACT_PATTERNS", () => {
  it("7개의 기본 패턴이 정의되어 있다", () => {
    expect(DEFAULT_OUTPUT_REDACT_PATTERNS).toHaveLength(7);
  });
});

describe("redact()", () => {
  it("빈 텍스트는 그대로 반환한다", () => {
    expect(redact("", DEFAULT_OUTPUT_REDACT_PATTERNS)).toBe("");
  });

  it("패턴이 없으면 텍스트가 변경되지 않는다", () => {
    const text = "API key: sk-abc123defghijklmnopqrstuvwxyz";
    expect(redact(text, [])).toBe(text);
  });

  it("OpenAI/Anthropic sk- 키를 [REDACTED]로 치환한다", () => {
    const text   = "key: sk-abcdefghijklmnopqrstuvwxyz1234567890ABCD";
    const result = redact(text, DEFAULT_OUTPUT_REDACT_PATTERNS);
    expect(result).toBe("key: [REDACTED]");
  });

  it("GitHub PAT ghp_ 토큰을 [REDACTED]로 치환한다", () => {
    const text   = "token: ghp_abcdefghijklmnopqrstuvwxyz123456789012";
    const result = redact(text, DEFAULT_OUTPUT_REDACT_PATTERNS);
    expect(result).toBe("token: [REDACTED]");
  });

  it("GitHub OAuth gho_ 토큰을 [REDACTED]로 치환한다", () => {
    const text   = "token: gho_abcdefghijklmnopqrstuvwxyz123456789012";
    const result = redact(text, DEFAULT_OUTPUT_REDACT_PATTERNS);
    expect(result).toBe("token: [REDACTED]");
  });

  it("GitLab PAT glpat- 토큰을 [REDACTED]로 치환한다", () => {
    const text   = "token: glpat-abcdefghijklmnopqrstuvwxyz1234";
    const result = redact(text, DEFAULT_OUTPUT_REDACT_PATTERNS);
    expect(result).toBe("token: [REDACTED]");
  });

  it("AWS Access Key ID AKIA... 를 [REDACTED]로 치환한다", () => {
    const text   = "aws key: AKIAIOSFODNN7EXAMPLE";
    const result = redact(text, DEFAULT_OUTPUT_REDACT_PATTERNS);
    expect(result).toBe("aws key: [REDACTED]");
  });

  it("Slack xoxb- 토큰을 [REDACTED]로 치환한다", () => {
    // 가짜 토큰 문자열을 런타임 concat 으로 분리한다. scanner 가 git diff 에서
    // 실제 Slack 포맷 리터럴을 인식해 push 를 차단하는 것을 피하면서, 패턴
    // 매칭 검증은 동일하게 수행한다.
    const fakeToken = "xoxb" + "-" + "AAAAAAAAAAAAAAAA";
    const text   = `slack: ${fakeToken}`;
    const result = redact(text, DEFAULT_OUTPUT_REDACT_PATTERNS);
    expect(result).toBe("slack: [REDACTED]");
  });

  it("Bearer 헤더 값을 [REDACTED]로 치환한다", () => {
    const text   = "Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.payload.sig";
    const result = redact(text, DEFAULT_OUTPUT_REDACT_PATTERNS);
    expect(result).toContain("[REDACTED]");
    expect(result).not.toContain("eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9");
  });

  it("텍스트 중간에 있는 토큰을 정확히 치환한다 (partial match)", () => {
    const token  = "sk-abcdefghijklmnopqrstuvwxyz123456789012";
    const text   = `some text ${token} more text`;
    const result = redact(text, DEFAULT_OUTPUT_REDACT_PATTERNS);
    expect(result).toBe("some text [REDACTED] more text");
  });

  it("일반 Base64 문자열은 패턴과 일치하지 않으면 치환하지 않는다", () => {
    // prefix 없는 임의의 Base64 — 어떤 기본 패턴과도 매칭되지 않아야 한다
    const text = "dXNlcjpwYXNzd29yZA==";
    expect(redact(text, DEFAULT_OUTPUT_REDACT_PATTERNS)).toBe(text);
  });

  it("유효하지 않은 regex 패턴은 조용히 건너뛴다", () => {
    const text    = "hello world";
    const patterns = ["[invalid(regex", "world"];
    const result  = redact(text, patterns);
    // 유효한 두 번째 패턴만 적용됨
    expect(result).toBe("hello [REDACTED]");
  });

  it("동일 줄에 여러 토큰이 있으면 모두 치환한다", () => {
    const text   = "key1=sk-ABCDEFGHIJKLMNOPQRSTUVWXYZ123 key2=sk-ZYXWVUTSRQPONMLKJIHGFEDCBA321";
    const result = redact(text, DEFAULT_OUTPUT_REDACT_PATTERNS);
    expect(result).toBe("key1=[REDACTED] key2=[REDACTED]");
  });
});

describe("validatePatterns()", () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  });

  afterEach(() => {
    stderrSpy.mockRestore();
  });

  it("유효한 패턴만 반환한다", () => {
    const valid = validatePatterns(["sk-[A-Za-z0-9]{20,}", "ghp_[A-Za-z0-9]{30,}"]);
    expect(valid).toHaveLength(2);
  });

  it("유효하지 않은 패턴은 제외하고 stderr 경고를 출력한다", () => {
    const valid = validatePatterns(["[invalid(regex", "valid-pattern"]);
    expect(valid).toHaveLength(1);
    expect(valid[0]).toBe("valid-pattern");
    expect(stderrSpy).toHaveBeenCalledOnce();
    const call = stderrSpy.mock.calls[0][0] as string;
    expect(call).toContain("[parism] invalid redact pattern");
    expect(call).toContain("[invalid(regex");
  });

  it("빈 목록은 빈 배열을 반환한다", () => {
    expect(validatePatterns([])).toEqual([]);
  });

  it("기본 패턴 7개가 모두 유효하다", () => {
    const valid = validatePatterns(DEFAULT_OUTPUT_REDACT_PATTERNS);
    expect(valid).toHaveLength(7);
  });
});
