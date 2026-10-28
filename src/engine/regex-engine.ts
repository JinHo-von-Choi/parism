/**
 * 정규식 엔진 선택 계층.
 *
 * ## 왜 두 엔진인가
 *
 * - **Rust 엔진** (`regex` 크레이트): 역추적 불가능. 어떤 패턴이든 **선형 시간**을 보장한다.
 *   사용자가 설정한 비밀 패턴이 `(a+)+` 같은 폭탄이어도 서버가 멈추지 않는다.
 * - **TypeScript 엔진** (V8 의 정규식): 빠르지만 역추적 엔진이다. 위험한 패턴에는 걸릴 수 있다.
 *
 * Rust 엔진이 **같은 결과를 내지 못하는** 패턴은 TypeScript 로 되돌린다. 그리고 그 사실을
 * 기록한다 — 조용히 바뀌면 "무엇이 왜 바뀌었는지"를 나중에 알 수 없다.
 *
 * ## 왜 번역이 필요한가
 *
 * JavaScript 의 정규식과 Rust 의 `regex` 크레이트는 **같은 문법이 같은 의미가 아니다.**
 *
 * | 표현 | JavaScript | Rust |
 * |------|-----------|------|
 * | `\b` | ASCII 단어 경계 | 유니코드 단어 경계 |
 * | `\d` `\w` | ASCII | 유니코드 |
 * | `\s` | ASCII + U+00A0 + U+FEFF … | ASCII + 유니코드 화이트스페이스 |
 * | `.` (s 플래그 없음) | `\n \r U+2028 U+2029` 제외 | `\n` 만 제외 |
 * | `i` 플래그 | ECMA-262 정규화 | 유니코드 단순 케이 폴딩 |
 * | `m` 플래그 | `\n \r U+2028 U+2029` | `\n` 만 |
 *
 * 번역 없이 Rust 로 보내면 **비밀을 안 가리는 결과**가 나올 수 있다. 그래서 차이를 알고
 * 찾아서 없앤다. 못 없애는 차이는 **전부 TypeScript 로 돌려보낸다.**
 *
 * ## 좌표계
 *
 * Rust 엔진은 **바이트 오프셋**을 준다. JavaScript 문자열 인덱스는 UTF-16 코드유닛이다.
 * 이 모듈이 변환한다. 밖으로 나가는 좌표는 언제나 **JavaScript 좌표**다.
 *
 * 작성자: 최진호
 * 작성일: 2026-10-22
 */

import { NativePatternError, loadNativeRegex, type NativeMatch } from "./regex-native.js";

/** 실제로 쓰인 엔진. */
export type RegexEngineName = "rust" | "typescript";

/** TypeScript 로 되돌아간 사실. */
export interface RegexFallback {
  /** 되돌아간 패턴. */
  pattern: string;
  /** 왜 되돌아갔는가. */
  reason:  string;
}

/** 호출 쪽에 알려줄 선택지. */
export interface RegexEngineOptions {
  /** TypeScript 로 되돌아갔을 때 호출된다. */
  onFallback?: (info: RegexFallback) => void;
}

/** 엔진 선택 결과. */
export interface RegexResult<T> {
  value:  T;
  engine: RegexEngineName;
}

/**
 * JavaScript 의 `\s` 가 가리키는 문자 집합.
 *
 * ECMA-262 의 WhiteSpace 와 LineTerminator 다. 유니코드 화이트스페이스 속성과 **두 군데** 다르다.
 * U+FEFF 는 JavaScript 에만 있고(무너진 BOM), U+0085 는 Rust 쪽에만 있다.
 * 그래서 명시적으로 적는다 — `\s` 를 그대로 옮기면 다른 문자에서 결과가 갈린다.
 */
const JS_WHITESPACE_CHARS = "\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff";

/** 문자 클래스 밖에서 쓰는 `\s` 대체. */
const JS_WHITESPACE_CLASS = `[${JS_WHITESPACE_CHARS}]`;

/** 문자 클래스 밖에서 쓰는 `\S` 대체. */
const JS_NON_WHITESPACE_CLASS = `[^${JS_WHITESPACE_CHARS}]`;

/** JavaScript 의 `.` (s 플래그 없음)이 제외하는 문자. */
const JS_DOT_EXCLUDED = "[^\\n\\r\\u2028\\u2029]";

/**
 * 번역 결과.
 *
 * **한쪽만 채워진다.** 옮길 수 있으면 `rust` 만, 없으면 `reason` 만 있다.
 * 둘 다 비면 그건 버그다 — 판별 가능하게 만들어 컴파일러가 잡게 한다.
 */
export type TranslationResult =
  | { rust: string;  reason?: undefined }
  | { rust?: undefined; reason: string };

/**
 * JavaScript 패턴을 Rust 패턴으로 옮긴다.
 *
 * 옮길 수 없는 차이가 있으면 **이유를 담아 돌려준다.** 그때 호출하는 쪽은 TypeScript 로 보낸다.
 */
export function translatePattern(pattern: string, flags: string): TranslationResult {
  if (flags.includes("i")) {
    return { reason: "the i flag uses ECMA-262 Canonicalize, which differs from Rust's Unicode case folding (U+017F and U+212A are the first divergences)" };
  }
  if (flags.includes("m")) {
    return { reason: "the m flag counts U+000D, U+2028 and U+2029 as line terminators in JavaScript but only U+000A in Rust" };
  }
  if (flags.includes("u")) {
    return { reason: "the u flag changes escape semantics; this engine does not translate it" };
  }
  if (flags.includes("y")) {
    return { reason: "the y (sticky) flag has no equivalent here" };
  }

  const dotMatchesNewLine = flags.includes("s");
  const out: string[] = [];
  let inClass    = false;
  let classStart = true;

  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i]!;

    if (ch === "\\") {
      const next = pattern[i + 1];
      if (next === undefined) return { reason: "pattern ends with a lone backslash" };
      i++;
      /**
       * 이스케이프 하나가 클래스 **첫 글자** 자리를 차지한다.
       * `[\b]` 에서 `\b`(백스페이스) 뒤의 `]` 는 클래스를 닫는 `]` 가 아니라 **문자** 다.
       * 여기서 표시를 안 지우면 `[\b]` 가 "클래스가 안 닫혔다" 로 잘못 판정된다(실측 결함).
       */
      if (inClass) classStart = false;
      switch (next) {
        /** 문자 클래스 안의 `\b` 는 백스페이스다. JavaScript 와 Rust 가 같다. */
        case "b":  out.push(inClass ? "\\x08" : "(?-u:\\b)"); break;
        case "B":  if (inClass) return { reason: "\\B inside a character class has no equivalent" };
                   out.push("(?-u:\\B)"); break;
        case "d":  out.push(inClass ? "0-9" : "(?-u:\\d)"); break;
        case "D":  if (inClass) return { reason: "\\D inside a character class cannot be expressed" };
                   out.push("(?-u:\\D)"); break;
        case "w":  out.push(inClass ? "A-Za-z0-9_" : "(?-u:\\w)"); break;
        case "W":  if (inClass) return { reason: "\\W inside a character class cannot be expressed" };
                   out.push("(?-u:\\W)"); break;
        case "s":  out.push(inClass ? JS_WHITESPACE_CHARS : JS_WHITESPACE_CLASS); break;
        case "S":  if (inClass) return { reason: "\\S inside a character class cannot be expressed" };
                   out.push(JS_NON_WHITESPACE_CLASS); break;
        default:   out.push("\\" + next); break;
      }
      continue;
    }

    if (!inClass && ch === "[") {
      inClass    = true;
      classStart = true;
      out.push(ch);
      continue;
    }
    if (inClass) {
      /** 문자 클래스의 첫 `]` 는 문자다. */
      if (ch === "]" && classStart) { classStart = false; out.push(ch); continue; }
      if (ch === "]") { inClass = false; out.push(ch); continue; }
      classStart = false;
      out.push(ch);
      continue;
    }

    if (ch === ".") {
      out.push(dotMatchesNewLine ? "." : JS_DOT_EXCLUDED);
      continue;
    }
    out.push(ch);
  }

  if (inClass) return { reason: "pattern has an unterminated character class" };
  return { rust: out.join("") };
}

/** 엔진 선택 모드. */
export type RegexEngineMode = "auto" | "rust" | "typescript";

/** 현재 모드. 환경변수로 강제할 수 있다. */
export function engineMode(): RegexEngineMode {
  const raw = process.env.PARISM_REGEX_ENGINE;
  if (raw === "rust" || raw === "typescript") return raw;
  return "auto";
}

/** TypeScript 로 되돌아간 사실을 알린다. */
function reportFallback(pattern: string, reason: string, opts?: RegexEngineOptions): void {
  opts?.onFallback?.({ pattern, reason });
}

/**
 * 예외를 사람이 읽을 문장으로 바꾼다.
 *
 * 두 호출부(구간 찾기·치환)가 같은 모양으로 실패를 처리해야 한다.
 * 한쪽만 다르게 처리하면 "왜 되돌아갔는지" 기록이 갈린다.
 */
function reasonOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * 바이트 오프셋을 UTF-16 인덱스로 옮긴다.
 *
 * 텍스트를 **한 번만** 훑는다. 문자열 인덱스는 UTF-16 코드유닛이라 바이트 좌표와 다르다.
 */
function byteToUtf16Map(text: string, offsets: readonly number[]): Map<number, number> {
  const wanted = new Set(offsets);
  const map    = new Map<number, number>();

  let bytePos  = 0;
  let utf16Pos = 0;
  for (const ch of text) {
    if (wanted.has(bytePos)) map.set(bytePos, utf16Pos);
    const cp = ch.codePointAt(0)!;
    bytePos  += cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4;
    utf16Pos += cp > 0xffff ? 2 : 1;
  }
  if (wanted.has(bytePos)) map.set(bytePos, utf16Pos);
  return map;
}

/** 엔진의 매칭(바이트)을 JavaScript 좌표로 옮긴다. */
function toJsRanges(text: string, matches: readonly NativeMatch[]): { start: number; end: number }[] {
  if (matches.length === 0) return [];
  const offsets: number[] = [];
  for (const m of matches) { offsets.push(m.start, m.end); }
  const map = byteToUtf16Map(text, offsets);
  return matches.map(m => ({
    start: map.get(m.start) ?? 0,
    end:   map.get(m.end)   ?? 0,
  }));
}

/**
 * 패턴의 모든 매칭 구간을 찾는다.
 *
 * **빈 매칭은 제외한다.** JavaScript 의 `exec` 루프가 빈 매칭에서 `lastIndex` 를 밀고
 * 건너뛰는 것과 같은 결과다.
 */
export async function findAllRanges(
  pattern: string,
  text:    string,
  flags:   string = "g",
  opts?:   RegexEngineOptions,
): Promise<RegexResult<{ start: number; end: number }[]>> {
  const mode = engineMode();

  if (mode !== "typescript") {
    const translated = translatePattern(pattern, flags);
    if (translated.rust !== undefined) {
      try {
        const native = loadNativeRegex();
        if (native) {
          /** JavaScript 에서 유효하지 않은 패턴은 JavaScript 경로에서도 건너뛴다. 먼저 확인한다. */
          new RegExp(pattern, flags);
          const matches = await native.findAll(translated.rust, text);
          const ranges  = toJsRanges(text, matches).filter(r => r.end > r.start);
          return { value: ranges, engine: "rust" };
        }
        reportFallback(pattern, "native regex binary is not available", opts);
      } catch (err) {
        if (err instanceof NativePatternError) {
          reportFallback(pattern, err.message, opts);
        } else if (err instanceof SyntaxError) {
          /** JavaScript 에서도 유효하지 않은 패턴이다. TypeScript 경로가 같은 사실을 알린다. */
        } else {
          reportFallback(pattern, reasonOf(err), opts);
        }
      }
    } else {
      reportFallback(pattern, translated.reason, opts);
    }
  }

  const re = new RegExp(pattern, flags.includes("g") ? flags : `${flags}g`);
  const ranges: { start: number; end: number }[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m[0].length === 0) { re.lastIndex++; continue; }
    ranges.push({ start: m.index, end: m.index + m[0].length });
  }
  return { value: ranges, engine: "typescript" };
}

/**
 * 패턴의 모든 매칭을 치환한다.
 *
 * `literal` 이면 치환 문자열을 **그대로** 넣는다. JavaScript 의 `String.replace` 는
 * 치환 문자열의 `$1` 을 그룹 참조로 펼치지만, 이 경로의 치환 문자열은 상수라서
 * 펼칠 일이 없다. 펼치지 않는 쪽이 더 좁고 안전하다.
 */
export async function replaceAllText(
  pattern:     string,
  text:        string,
  replacement: string,
  flags:       string = "g",
  literal:     boolean = true,
  opts?:       RegexEngineOptions,
): Promise<RegexResult<string>> {
  const mode = engineMode();

  if (mode !== "typescript") {
    const translated = translatePattern(pattern, flags);
    if (translated.rust !== undefined) {
      try {
        const native = loadNativeRegex();
        if (!native) {
          reportFallback(pattern, "native regex binary is not available", opts);
        } else {
          new RegExp(pattern, flags);
          /**
           * JavaScript 의 `String.replace` 는 치환 문자열의 `$1` 을 펼친다.
           * Rust 경로는 리터럴 치환이므로, `$` 가 들어 있으면 결과가 달라질 수 있다.
           * 이때는 TypeScript 로 보낸다.
           */
          if (replacement.includes("$")) {
            reportFallback(pattern, "replacement contains $, which JavaScript expands but the native engine does not", opts);
          } else {
            const out = await native.replaceAll(translated.rust, text, replacement, literal);
            if (out.exact) return { value: out.text, engine: "rust" };
            reportFallback(pattern, "the native engine cannot reproduce JavaScript's empty-match order for this text", opts);
          }
        }
      } catch (err) {
        if (err instanceof NativePatternError) {
          reportFallback(pattern, err.message, opts);
        } else if (err instanceof SyntaxError) {
          /** JavaScript 에서도 유효하지 않은 패턴이다. */
        } else {
          reportFallback(pattern, reasonOf(err), opts);
        }
      }
    } else {
      reportFallback(pattern, translated.reason, opts);
    }
  }

  const re = new RegExp(pattern, flags.includes("g") ? flags : `${flags}g`);
  return { value: text.replace(re, replacement), engine: "typescript" };
}
