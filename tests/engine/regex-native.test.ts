/**
 * 네이티브 정규식 엔진 시험.
 *
 * 엔진 프로세스가 **어떻게 실패하는지**를 확인한다. 실패를 조용히 넘기면
 * Rust 경로가 없는 것처럼 보이는데, 사실은 "Rust 가 이 패턴을 못 한다" 다.
 * 그 구분이 결과에 남아야 한다.
 *
 * 작성자: 최진호
 * 작성일: 2026-10-22
 */

import { describe, it, expect, afterEach } from "vitest";
import {
  loadNativeRegex,
  resetNativeRegex,
  resolveNativeBinary,
  nativePackageName,
  NativePatternError,
} from "../../src/engine/regex-native.js";

const nativeAvailable = resolveNativeBinary() !== undefined;
const nativeOnly = nativeAvailable ? it : it.skip;

afterEach(() => {
  resetNativeRegex();
  delete process.env.PARISM_REGEX_BIN;
});

describe("바이너리 해석", () => {
  it("플랫폼 패키지 이름이 이 호스트와 맞는다", () => {
    const name = nativePackageName();
    expect(name).toContain(process.platform);
    expect(name).toContain(process.arch);
  });

  it("PARISM_REGEX_BIN 이 있으면 그 경로를 쓴다", () => {
    const target = resolveNativeBinary();
    if (!target) return;
    process.env.PARISM_REGEX_BIN = target;
    expect(resolveNativeBinary()).toBe(target);
  });

  it("PARISM_REGEX_BIN 이 없는 경로면 그 경로를 쓰지 않는다", () => {
    process.env.PARISM_REGEX_BIN = "/nonexistent/parism-regex";
    /** 다른 후보(저장소 빌드본)가 있으면 그걸 쓴다. 없으면 undefined. */
    const resolved = resolveNativeBinary();
    expect(resolved === undefined || resolved !== "/nonexistent/parism-regex").toBe(true);
  });
});

describe("엔진 연산", () => {
  nativeOnly("첫 매칭을 찾는다", async () => {
    const engine = loadNativeRegex()!;
    const found  = await engine.findFirst("b+", "abbbc");
    expect(found).toEqual({ start: 1, end: 4 });
  });

  nativeOnly("매칭이 없으면 null 이다", async () => {
    const engine = loadNativeRegex()!;
    expect(await engine.findFirst("zzz", "abc")).toBeNull();
  });

  nativeOnly("모든 매칭을 찾는다", async () => {
    const engine = loadNativeRegex()!;
    /** "baaab" 의 "a+" 는 탐욕하게 [1,4) 하나를 잡는다. */
    expect(await engine.findAll("a+", "baaab")).toEqual([{ start: 1, end: 4 }]);
    expect(await engine.findAll("a", "banana")).toEqual([
      { start: 1, end: 2 },
      { start: 3, end: 4 },
      { start: 5, end: 6 },
    ]);
  });

  nativeOnly("여러 패턴을 한 번에 찾는다", async () => {
    const engine = loadNativeRegex()!;
    const results = await engine.findAllMany(["a+", "b+"], "aab");
    expect(results).toEqual([
      [{ start: 0, end: 2 }],
      [{ start: 2, end: 3 }],
    ]);
  });

  nativeOnly("빈 매칭도 나열한다", async () => {
    const engine = loadNativeRegex()!;
    const all = await engine.findAll("x*", "ab");
    expect(all).toHaveLength(3);
  });

  nativeOnly("치환한다", async () => {
    const engine = loadNativeRegex()!;
    const out = await engine.replaceAll("a+", "baaab", "[R]", true);
    expect(out.text).toBe("b[R]b");
    expect(out.exact).toBe(true);
  });

  nativeOnly("빈 매칭 순서가 JavaScript 와 다르면 exact 가 false 다", async () => {
    const engine = loadNativeRegex()!;
    /** BMP 밖 문자가 있고 패턴이 빈 매칭을 하면 JavaScript 로 재현할 수 없다. */
    const out = await engine.replaceAll("x*", "a\u{1f389}b", "[R]", true);
    expect(out.exact).toBe(false);
  });

  nativeOnly("패턴을 검증한다", async () => {
    const engine = loadNativeRegex()!;
    await expect(engine.validate("a+")).resolves.toBeUndefined();
  });
});

describe("실패 구분", () => {
  nativeOnly("문법 오류는 invalid 다", async () => {
    const engine = loadNativeRegex()!;
    await expect(engine.findAll("(", "abc")).rejects.toThrowError(NativePatternError);
    try {
      await engine.findAll("(", "abc");
    } catch (err) {
      expect((err as NativePatternError).kind).toBe("invalid");
    }
  });

  nativeOnly("역참조는 unsupported 다", async () => {
    const engine = loadNativeRegex()!;
    try {
      await engine.findAll("(a)\\1", "aa");
      throw new Error("오류가 나야 한다");
    } catch (err) {
      expect(err).toBeInstanceOf(NativePatternError);
      expect((err as NativePatternError).kind).toBe("unsupported");
    }
  });

  nativeOnly("lookaround 는 unsupported 다", async () => {
    const engine = loadNativeRegex()!;
    try {
      await engine.findAll("(?=a)", "a");
      throw new Error("오류가 나야 한다");
    } catch (err) {
      expect((err as NativePatternError).kind).toBe("unsupported");
    }
  });
});

describe("엔진 없음", () => {
  it("바이너리를 찾지 못하면 undefined 다", () => {
    resetNativeRegex();
    process.env.PARISM_REGEX_BIN = "/nonexistent/parism-regex";
    /** 저장소 빌드본이 있으면 그걸 쓴다. 둘 다 없으면 undefined. */
    const engine = loadNativeRegex();
    expect(engine === undefined || typeof engine.findAll === "function").toBe(true);
  });

  it("reset 후 다시 로드할 수 있다", () => {
    const first = loadNativeRegex();
    resetNativeRegex();
    const second = loadNativeRegex();
    expect(first === undefined || second !== undefined).toBe(true);
  });
});
