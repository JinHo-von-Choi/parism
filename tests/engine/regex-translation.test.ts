/**
 * 패턴 번역 시험 — JavaScript 정규식을 Rust 정규식으로 옮길 때의 결정.
 *
 * ## 왜 이 파일이 따로 있는가
 *
 * 번역이 틀리면 **결과가 조용히 달라진다.** 비밀을 안 가리는 결과가 나올 수 있다.
 * 그러니 번역 결과가 **무엇을 왜 했는지** 를 하나씩 고정한다.
 *
 * ## 옮기지 못하는 것은 옮기지 않는다
 *
 * 옮길 수 없는 차이(대소문자 폴딩, 줄바꿈 의미, 역참조, lookaround)는
 * **이유와 함께 TypeScript 로 되돌려보낸다.** 조용히 비슷한 것으로 바꾸지 않는다.
 *
 * 작성자: 최진호
 * 작성일: 2026-10-22
 */

import { describe, it, expect } from "vitest";
import { translatePattern } from "../../src/engine/regex-engine.js";

describe("옮길 수 없는 플래그", () => {
  it("u 플래그는 옮기지 않는다", () => {
    const result = translatePattern("a+", "gu");
    expect(result.rust).toBeUndefined();
    expect(result.reason).toContain("u flag");
  });

  it("y (sticky) 플래그는 옮기지 않는다", () => {
    const result = translatePattern("a+", "gy");
    expect(result.rust).toBeUndefined();
    expect(result.reason).toContain("sticky");
  });

  it("i 플래그의 사유는 정규화 방식의 차이를 말한다", () => {
    const result = translatePattern("secret", "gi");
    expect(result.reason).toContain("Canonicalize");
  });

  it("m 플래그의 사유는 줄바꿈 문자 집합의 차이를 말한다", () => {
    const result = translatePattern("^a$", "gm");
    expect(result.reason).toContain("line terminators");
  });
});

describe("문자 클래스 안의 이스케이프", () => {
  it("클래스 안의 \\b 는 백스페이스다", () => {
    expect(translatePattern("[\\b]", "g").rust).toBe("[\\x08]");
  });

  it("클래스 안의 \\d 는 범위로 옮긴다", () => {
    expect(translatePattern("[\\d]", "g").rust).toBe("[0-9]");
  });

  it("클래스 안의 \\w 는 문자 집합으로 옮긴다", () => {
    expect(translatePattern("[\\w]", "g").rust).toBe("[A-Za-z0-9_]");
  });

  it("클래스 안의 \\s 는 JavaScript 의 집합 그대로다", () => {
    expect(translatePattern("[\\s]", "g").rust).toBe("[\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff]");
  });

  it("클래스 밖의 \\D 는 유니코드를 끈다", () => {
    expect(translatePattern("\\D", "g").rust).toBe("(?-u:\\D)");
  });

  it("클래스 밖의 \\W 는 유니코드를 끈다", () => {
    expect(translatePattern("\\W", "g").rust).toBe("(?-u:\\W)");
  });

  it("클래스 밖의 \\B 는 유니코드를 끈다", () => {
    expect(translatePattern("\\B", "g").rust).toBe("(?-u:\\B)");
  });

  it("클래스 안의 \\B 는 옮길 수 없다", () => {
    const result = translatePattern("[\\B]", "g");
    expect(result.rust).toBeUndefined();
    expect(result.reason).toContain("character class");
  });

  it("클래스 안의 \\D 는 범위 밖이라 옮길 수 없다", () => {
    const result = translatePattern("[\\D]", "g");
    expect(result.rust).toBeUndefined();
    expect(result.reason).toContain("\\D");
  });

  it("클래스 안의 \\W 는 범위 밖이라 옮길 수 없다", () => {
    const result = translatePattern("[\\W]", "g");
    expect(result.rust).toBeUndefined();
    expect(result.reason).toContain("\\W");
  });
});

describe("문자 클래스의 경계", () => {
  it("클래스 맨 앞의 ] 는 문자다", () => {
    expect(translatePattern("[]a]", "g").rust).toBe("[]a]");
  });

  it("클래스가 닫히지 않으면 옮기지 않는다", () => {
    const result = translatePattern("[abc", "g");
    expect(result.rust).toBeUndefined();
    expect(result.reason).toContain("unterminated");
  });

  it("이스케이프가 첫 글자 자리를 차지하면 뒤의 ] 는 닫는 괄호다", () => {
    /**
     * `[\b]` 에서 `\b`(백스페이스) 뒤의 `]` 는 **문자** 가 아니라 클래스 닫는 괄호다.
     * 표시를 안 지우면 `[\b]` 가 "닫히지 않은 클래스" 로 잘못 판정된다(실측 결함).
     */
    expect(translatePattern("[\\b]", "g").rust).toBe("[\\x08]");
    expect(translatePattern("[a\\b]", "g").rust).toBe("[a\\x08]");
  });
});

describe("패턴 모양", () => {
  it("단독 백슬래시는 옮기지 않는다", () => {
    const result = translatePattern("a\\", "g");
    expect(result.rust).toBeUndefined();
    expect(result.reason).toContain("lone backslash");
  });

  it("dot 은 JavaScript 의 제외 문자 집합으로 옮긴다", () => {
    expect(translatePattern("a.c", "g").rust).toBe("a[^\\n\\r\\u2028\\u2029]c");
  });

  it("s 플래그가 있으면 dot 은 그대로다", () => {
    expect(translatePattern("a.c", "gs").rust).toBe("a.c");
  });

  it("명명 그룹은 그대로 통과한다", () => {
    expect(translatePattern("(?<name>\\w+)", "g").rust).toBe("(?<name>(?-u:\\w)+)");
  });

  it("역참조는 옮기지 않는다 — Rust 가 거절하고 TypeScript 로 되돌아간다", () => {
    /**
     * 번역 단계에서 걸러내지 않는다. Rust 엔진이 거절하고 그 사유가 그대로 기록된다.
     * 그래야 "왜 되돌아갔는지"가 사용자에게 보인다.
     */
    expect(translatePattern("(a)\\1", "g").rust).toBe("(a)\\1");
  });
});
