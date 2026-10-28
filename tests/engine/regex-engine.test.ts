/**
 * 정규식 엔진 시험.
 *
 * Rust 엔진이 **JavaScript 와 같은 결과**를 내는지 확인한다. 다르다면 Rust 로 보내지 않는다.
 * 이 파일의 존재 이유가 이것이다 — "Rust 가 빠르다" 는 사실과
 * "Rust 가 같은 결과를 낸다" 는 사실은 별개다.
 *
 * 코퍼스는 저장소의 **실제 명령 출력**(파서 팩의 fixture 입력)이다.
 * 합성 문자열이 아니라 실제 `ip -brief link`, `lsblk`, `systemctl` 같은 출력을 쓴다.
 *
 * 작성자: 최진호
 * 작성일: 2026-10-22
 */

import { describe, it, expect, afterAll } from "vitest";
import { translatePattern, findAllRanges, replaceAllText, engineMode } from "../../src/engine/regex-engine.js";
import { resolveNativeBinary, resetNativeRegex }          from "../../src/engine/regex-native.js";
import { redact, DEFAULT_OUTPUT_REDACT_PATTERNS }        from "../../src/engine/redactor.js";
import { maskWithRanges }                                from "../../src/engine/mask-map.js";
import { sanitizeText }                                  from "../../src/fixtures/sanitize.js";
import { createRegistry }                                from "../../src/parsers/index.js";

/** 네이티브 바이너리가 있어야 Rust 경로를 시험할 수 있다. */
const nativeAvailable = resolveNativeBinary() !== undefined;
const nativeOnly = nativeAvailable ? it : it.skip;

/** 엔진 모드를 강제로 바꾼다. */
async function withEngine<T>(mode: "rust" | "typescript", fn: () => Promise<T>): Promise<T> {
  const before = process.env.PARISM_REGEX_ENGINE;
  process.env.PARISM_REGEX_ENGINE = mode;
  try {
    return await fn();
  } finally {
    if (before === undefined) delete process.env.PARISM_REGEX_ENGINE;
    else process.env.PARISM_REGEX_ENGINE = before;
  }
}

/** 저장소의 실제 명령 출력을 모은다. */
function collectRealOutputs(): string[] {
  const registry = createRegistry();
  const out: string[] = [];
  for (const name of registry.listPacks()) {
    const pack = registry.getPack(name);
    for (const fixture of pack?.fixtures ?? []) {
      if (typeof fixture.input === "string" && fixture.input.length > 0) out.push(fixture.input);
    }
  }
  return out;
}

const REAL_OUTPUTS = collectRealOutputs();

/** 적대적인 문자열. 유니코드 경계와 빈 매칭이 걸리는 자리들. */
const ADVERSARIAL = [
  "",
  "plain ascii",
  "Bearer abcdefghijklmnop",
  "token=supersecret",
  "--token=supersecret",
  "  \t\n\r  ",
  " non breaking",
  "﻿bom at start",
  "line1\r\nline2",
  "café naïve",
  "한국어 텍스트입니다",
  "emoji \u{1f389} here",
  "\u{1f389}\u{1f389}\u{1f389}",
  "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345",
  "ÅÄÖ åäö",
  "İstanbul ı",
  "ſecret",
];

/** 실제 기본 패턴 + 경계 문법을 쓰는 패턴들. */
const PATTERNS = [
  ...DEFAULT_OUTPUT_REDACT_PATTERNS,
  "\\b(?:gh[pousr]_[A-Za-z0-9]{16,}|glpat-[A-Za-z0-9\\-_]{16,}|AKIA[0-9A-Z]{16})\\b",
  "\\b(--?(?:token|password|passwd|secret|api[-_]?key|auth)(?:=|\\s+))(\\S+)",
  "\\d+",
  "\\w+",
  "\\s+",
  "\\S+",
  "[a-z\\d]+",
  "[^\\s]+",
  ".+",
  ".*",
  "a.c",
  "\\bfoo\\b",
  "\\Bfoo",
  "[\\w.-]+@[\\w.-]+",
  "x{2,}",
  "(?<name>\\w+)",
];

describe("translatePattern", () => {
  it("단어 경계를 ASCII 로 옮긴다", () => {
    expect(translatePattern("\\bword\\b", "g").rust).toBe("(?-u:\\b)word(?-u:\\b)");
  });

  it("숫자와 단어를 ASCII 로 옮긴다", () => {
    expect(translatePattern("\\d+\\w+", "g").rust).toBe("(?-u:\\d)+(?-u:\\w)+");
  });

  it("화이트스페이스를 JavaScript 의 집합으로 옮긴다", () => {
    const translated = translatePattern("\\s+", "g").rust!;
    /** JavaScript 의 \\s 에는 U+FEFF 가 있다. Rust 의 유니코드 \\s 에는 없다. */
    expect(translated).toContain("\\ufeff");
  });

  it("문자 클래스 안의 \\d 를 범위로 옮긴다", () => {
    expect(translatePattern("[a-z\\d]+", "g").rust).toBe("[a-z0-9]+");
  });

  it("dot 을 JavaScript 의 제외 문자 집합으로 옮긴다", () => {
    expect(translatePattern("a.c", "g").rust).toBe("a[^\\n\\r\\u2028\\u2029]c");
  });

  it("s 플래그가 있으면 dot 을 그대로 둔다", () => {
    expect(translatePattern("a.c", "gs").rust).toBe("a.c");
  });

  it("i 플래그는 옮기지 않는다", () => {
    const result = translatePattern("secret", "gi");
    expect(result.rust).toBeUndefined();
    expect(result.reason).toContain("Canonicalize");
  });

  it("m 플래그는 옮기지 않는다", () => {
    expect(translatePattern("^a$", "gm").rust).toBeUndefined();
  });

  it("문자 클래스 안의 \\S 는 옮기지 않는다", () => {
    const result = translatePattern("[\\S]", "g");
    expect(result.rust).toBeUndefined();
    expect(result.reason).toContain("character class");
  });
});

describe("Rust 엔진과 TypeScript 엔진의 결과 일치", () => {
  it("패턴 × 텍스트 조합에서 구간이 같다", async () => {
    let checked = 0;
    for (const pattern of PATTERNS) {
      for (const text of ADVERSARIAL) {
        let jsRanges: [number, number][];
        try {
          const re = new RegExp(pattern, "g");
          jsRanges = [];
          let m: RegExpExecArray | null;
          while ((m = re.exec(text)) !== null) {
            if (m[0].length === 0) { re.lastIndex++; continue; }
            jsRanges.push([m.index, m.index + m[0].length]);
          }
        } catch {
          continue;
        }
        const rust = await withEngine("rust", () => findAllRanges(pattern, text, "g"));
        expect(rust.value.map(r => [r.start, r.end]), `${pattern} / ${text}`).toEqual(jsRanges);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(100);
  });

  it("패턴 × 텍스트 조합에서 치환 결과가 같다", async () => {
    let checked = 0;
    for (const pattern of PATTERNS) {
      for (const text of ADVERSARIAL) {
        let jsOut: string;
        try { jsOut = text.replace(new RegExp(pattern, "g"), "[R]"); } catch { continue; }
        const rust = await withEngine("rust", () => replaceAllText(pattern, text, "[R]", "g", true));
        expect(rust.value, `${pattern} / ${text}`).toBe(jsOut);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(100);
  });
});

describe("바이트 동일성 — 실제 명령 출력", () => {
  it("정제 결과가 Rust 활성/비활성에서 바이트 단위로 같다", async () => {
    expect(REAL_OUTPUTS.length).toBeGreaterThan(0);
    for (const output of REAL_OUTPUTS) {
      const ts   = await withEngine("typescript", () => sanitizeText(output, { home: "/home/tester" }));
      const rust = await withEngine("rust", () => sanitizeText(output, { home: "/home/tester" }));
      expect(
        Buffer.compare(Buffer.from(rust.text, "utf8"), Buffer.from(ts.text, "utf8")),
        output.slice(0, 40),
      ).toBe(0);
      expect(rust.redactions).toEqual(ts.redactions);
      expect(rust.ranges).toEqual(ts.ranges);
    }
  });

  it("리댁션 결과가 Rust 활성/비활성에서 바이트 단위로 같다", async () => {
    for (const output of REAL_OUTPUTS) {
      const ts   = await withEngine("typescript", () => redact(output, DEFAULT_OUTPUT_REDACT_PATTERNS));
      const rust = await withEngine("rust", () => redact(output, DEFAULT_OUTPUT_REDACT_PATTERNS));
      expect(Buffer.compare(Buffer.from(rust, "utf8"), Buffer.from(ts, "utf8")), output.slice(0, 40)).toBe(0);
    }
  });

  it("마스킹 구간이 Rust 활성/비활성에서 같다", async () => {
    for (const output of REAL_OUTPUTS) {
      const ts   = await withEngine("typescript", () => maskWithRanges(output, DEFAULT_OUTPUT_REDACT_PATTERNS));
      const rust = await withEngine("rust", () => maskWithRanges(output, DEFAULT_OUTPUT_REDACT_PATTERNS));
      expect(rust.ranges, output.slice(0, 40)).toEqual(ts.ranges);
      expect(rust.text, output.slice(0, 40)).toBe(ts.text);
    }
  });
});

describe("폴백 기록", () => {
  it("치환 문자열에 $ 가 있으면 TypeScript 로 되돌아간다", async () => {
    const fallbacks: { pattern: string; reason: string }[] = [];
    const result = await replaceAllText("a+", "aaa", "[$&]", "g", true, {
      onFallback: info => fallbacks.push(info),
    });
    expect(result.engine).toBe("typescript");
    expect(fallbacks[0]!.reason).toContain("$");
  });

  it("빈 매칭 순서를 재현할 수 없으면 TypeScript 로 되돌아간다", async () => {
    const fallbacks: { pattern: string; reason: string }[] = [];
    /** 패턴이 빈 매칭을 하고 텍스트에 BMP 밖 문자가 있다. */
    const result = await replaceAllText("x*", "a\u{1f389}b", "[R]", "g", true, {
      onFallback: info => fallbacks.push(info),
    });
    expect(result.engine).toBe("typescript");
    expect(fallbacks[0]!.reason).toContain("empty-match order");
  });

  it("바이너리가 없으면 모든 패턴이 되돌아간다", async () => {
    resetNativeRegex();
    process.env.PARISM_REGEX_BIN = "/nonexistent/parism-regex";
    try {
      const fallbacks: { pattern: string; reason: string }[] = [];
      const result = await findAllRanges("a+", "aaa", "g", { onFallback: info => fallbacks.push(info) });
      expect(result.engine).toBe("typescript");
      expect(fallbacks[0]!.reason).toContain("not available");
    } finally {
      delete process.env.PARISM_REGEX_BIN;
      resetNativeRegex();
    }
  });

  it("JavaScript 에서도 유효하지 않은 패턴은 SyntaxError 다", async () => {
    await expect(findAllRanges("(", "abc", "g")).rejects.toThrowError(SyntaxError);
  });

  it("실행할 수 없는 바이너리면 엔진 오류로 돌아온다", async () => {
    resetNativeRegex();
    process.env.PARISM_REGEX_BIN = "/etc/hostname";
    try {
      const fallbacks: { pattern: string; reason: string }[] = [];
      const result = await findAllRanges("a+", "aaa", "g", { onFallback: info => fallbacks.push(info) });
      expect(result.engine).toBe("typescript");
      expect(fallbacks.length).toBeGreaterThan(0);
    } finally {
      delete process.env.PARISM_REGEX_BIN;
      resetNativeRegex();
    }
  });

  it("i 플래그 패턴은 TypeScript 로 되돌아가고 그 사실을 알린다", async () => {
    const fallbacks: { pattern: string; reason: string }[] = [];
    const result = await findAllRanges("secret", "a secret", "gi", {
      onFallback: info => fallbacks.push(info),
    });
    expect(result.engine).toBe("typescript");
    expect(fallbacks).toHaveLength(1);
    expect(fallbacks[0]!.reason).toContain("Canonicalize");
  });

  it("네이티브 바이너리가 없으면 모든 패턴이 되돌아간다", async () => {
    if (nativeAvailable) return;
    const fallbacks: { pattern: string; reason: string }[] = [];
    const result = await findAllRanges("a+", "aaa", "g", { onFallback: info => fallbacks.push(info) });
    expect(result.engine).toBe("typescript");
    expect(fallbacks.length).toBeGreaterThan(0);
  });
});

describe("역추적 방어", () => {
  nativeOnly("역추적 폭탄 패턴도 즉시 끝난다", async () => {
    const text = "a".repeat(32) + "!";
    const started = process.hrtime.bigint();
    const result = await withEngine("rust", () => replaceAllText("(a+)+$", text, "[R]", "g", true));
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
    expect(result.engine).toBe("rust");
    expect(elapsedMs).toBeLessThan(1000);
  });

  it("역참조는 Rust 가 거절하고 TypeScript 로 되돌아간다", async () => {
    const fallbacks: { pattern: string; reason: string }[] = [];
    const result = await findAllRanges("(a)\\1", "aa", "g", { onFallback: info => fallbacks.push(info) });
    expect(result.engine).toBe("typescript");
    expect(fallbacks.length).toBeGreaterThan(0);
  });

  it("lookaround 는 Rust 가 거절하고 TypeScript 로 되돌아간다", async () => {
    for (const pattern of ["(?=a)", "(?!a)", "(?<=a)", "(?<!a)"]) {
      const fallbacks: { pattern: string; reason: string }[] = [];
      const result = await findAllRanges(pattern, "a", "g", { onFallback: info => fallbacks.push(info) });
      expect(result.engine, pattern).toBe("typescript");
      expect(fallbacks.length, pattern).toBeGreaterThan(0);
    }
  });
});

describe("환경 변수 모드", () => {
  afterAll(() => { delete process.env.PARISM_REGEX_ENGINE; });

  it("typescript 모드는 언제나 TypeScript 엔진을 쓴다", async () => {
    const result = await withEngine("typescript", () => findAllRanges("a+", "aaa", "g"));
    expect(result.engine).toBe("typescript");
  });

  it("기본 모드는 자동이다", () => {
    delete process.env.PARISM_REGEX_ENGINE;
    expect(engineMode()).toBe("auto");
  });
});

describe("플래그가 g 가 아닐 때", () => {
  it("구간 찾기는 g 를 붙여 모든 매칭을 찾는다", async () => {
    const ts   = await withEngine("typescript", () => findAllRanges("a", "banana", ""));
    const rust = await withEngine("rust", () => findAllRanges("a", "banana", ""));
    expect(ts.value.length).toBe(3);
    expect(rust.value).toEqual(ts.value);
  });

  it("치환도 g 를 붙여 모든 매칭을 바꾼다", async () => {
    const ts   = await withEngine("typescript", () => replaceAllText("a", "banana", "[R]", "", true));
    const rust = await withEngine("rust", () => replaceAllText("a", "banana", "[R]", "", true));
    expect(ts.value).toBe("b[R]n[R]n[R]");
    expect(rust.value).toBe(ts.value);
  });
});

describe("치환 경로의 실패", () => {
  it("바이너리가 없으면 TypeScript 로 되돌아간다", async () => {
    resetNativeRegex();
    process.env.PARISM_REGEX_BIN = "/nonexistent/parism-regex";
    try {
      const fallbacks: { pattern: string; reason: string }[] = [];
      const result = await replaceAllText("a+", "aaa", "[R]", "g", true, {
        onFallback: info => fallbacks.push(info),
      });
      expect(result.engine).toBe("typescript");
      expect(result.value).toBe("[R]");
      expect(fallbacks[0]!.reason).toContain("not available");
    } finally {
      delete process.env.PARISM_REGEX_BIN;
      resetNativeRegex();
    }
  });

  it("바이너리가 있으면 '없음' 이라고 하지 않는다", async () => {
    /**
     * 이전에는 `$` 나 빈 매칭 순서 때문에 되돌아간 뒤에도
     * "바이너리가 없습니다" 라는 **거짓 이유**가 추가로 기록되었다.
     * 사유는 사실이어야 한다 — 근거로 쓰는 값이니까.
     */
    const fallbacks: { pattern: string; reason: string }[] = [];
    await replaceAllText("a+", "aaa", "[$&]", "g", true, {
      onFallback: info => fallbacks.push(info),
    });
    expect(fallbacks.length).toBe(1);
    expect(fallbacks[0]!.reason).not.toContain("not available");
  });

  it("Rust 가 거절한 패턴은 그 사유를 그대로 알린다", async () => {
    const fallbacks: { pattern: string; reason: string }[] = [];
    const result = await replaceAllText("(a)\\1", "aa", "[R]", "g", true, {
      onFallback: info => fallbacks.push(info),
    });
    expect(result.engine).toBe("typescript");
    /** JavaScript 의 `/(a)\1/g` 는 "aa" 를 통째로 잡는다. */
    expect(result.value).toBe("[R]");
    expect(fallbacks.length).toBeGreaterThan(0);
    expect(fallbacks[0]!.reason).toContain("backreference");
  });

  it("JavaScript 에서도 유효하지 않은 패턴은 SyntaxError 다", async () => {
    await expect(replaceAllText("(", "abc", "[R]", "g", true)).rejects.toThrowError(SyntaxError);
  });

  it("실행할 수 없는 바이너리면 엔진 오류로 돌아온다", async () => {
    resetNativeRegex();
    process.env.PARISM_REGEX_BIN = "/etc/hostname";
    try {
      const fallbacks: { pattern: string; reason: string }[] = [];
      const result = await replaceAllText("a+", "aaa", "[R]", "g", true, {
        onFallback: info => fallbacks.push(info),
      });
      expect(result.engine).toBe("typescript");
      expect(fallbacks.length).toBeGreaterThan(0);
    } finally {
      delete process.env.PARISM_REGEX_BIN;
      resetNativeRegex();
    }
  });
});
