/**
 * 네이티브 엔진 프로토콜 시험 — **고장 난 엔진**을 상대한다.
 *
 * ## 왜 이 파일이 있는가
 *
 * Rust 엔진은 별도 프로세스다. 언제 죽을지 모른다.
 *
 * - 프로세스가 죽는다 (패턴 파싱 오류로, 또는 그 자체로).
 * - 응답이 **잘려서** 도착한다 (죽는 동안 쓰다만 응답).
 * - 길이가 어긋난 프레임이 도착한다.
 * - 아무도 기다리지 않는 id 의 프레임이 도착한다.
 *
 * 어느 경우든 **Node 프로세스가 죽으면 안 된다.** 엔진 하나가 죽은 것 때문에
 * 서버까지 죽으면 그건 엔진 문제가 아니라 구조 문제다.
 *
 * 그래서 **고장 난 엔진을 직접 만든다** (`tests/fixtures/fake-native-regex.mjs`).
 * 실제 Rust 바이너리를 흉내 내지 않는다 — 고장만 낸다.
 *
 * ## 되돌아가는 방향
 *
 * 엔진이 죽으면 호출하는 쪽은 **TypeScript 로 되돌아간다.** 그리고 그 사실을 기록한다.
 * 조용히 넘어가면 "Rust 가 이 패턴을 못 한다" 와 "Rust 가 죽었다" 를 구별할 수 없다.
 *
 * 작성자: 최진호
 * 작성일: 2026-10-22
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, join }    from "node:path";

import {
  loadNativeRegex,
  resetNativeRegex,
  takeFrame,
  NativeUnavailableError,
} from "../../src/engine/regex-native.js";
import {
  findAllRanges,
  type RegexFallback,
} from "../../src/engine/regex-engine.js";

const here    = dirname(fileURLToPath(import.meta.url));
const FAKE_BIN = join(here, "..", "fixtures", "fake-native-regex.mjs");

/** Windows 는 셰방 executable bit 이 없다 — 가짜 엔진 시험을 건너뛴다. */
const canSpawnScript = process.platform !== "win32";

beforeEach(() => {
  resetNativeRegex();
  delete process.env.PARISM_REGEX_BIN;
  delete process.env.FAKE_NATIVE_MODE;
  delete process.env.PARISM_REGEX_TIMEOUT_MS;
});

afterEach(() => {
  resetNativeRegex();
  delete process.env.PARISM_REGEX_BIN;
  delete process.env.FAKE_NATIVE_MODE;
  delete process.env.PARISM_REGEX_TIMEOUT_MS;
});

describe("프레임 해석", () => {
  it("아직 다 안 받은 프레임은 기다린다", () => {
    /** 길이 헤더만 있고 본문이 없다. */
    const header = Buffer.alloc(4);
    header.writeUInt32LE(64, 0);
    expect(takeFrame(header)).toBeNull();
  });

  it("헤더보다 짧은 본문은 잘린 프레임이다", () => {
    /** 선언한 총길이(3)만큼 온 뒤에도 헤더(10바이트)에 못 미친다. */
    const header = Buffer.alloc(4);
    header.writeUInt32LE(3, 0);
    const body = Buffer.alloc(3);
    expect(() => takeFrame(Buffer.concat([header, body]))).toThrowError(NativeUnavailableError);
  });

  it("메시지 길이가 본문보다 길면 잘린 프레임이다", () => {
    const body = Buffer.alloc(10);
    body.writeUInt8(0, 0);
    body.writeUInt32LE(1, 1);
    body.writeUInt8(0, 5);
    body.writeUInt32LE(999, 6);
    const header = Buffer.alloc(4);
    header.writeUInt32LE(body.length, 0);
    expect(() => takeFrame(Buffer.concat([header, body]))).toThrowError(/truncated/);
  });

  it("올바른 프레임은 읽는다", () => {
    const body = Buffer.alloc(10);
    body.writeUInt8(0, 0);
    body.writeUInt32LE(7, 1);
    body.writeUInt8(2, 5);
    body.writeUInt32LE(0, 6);
    const header = Buffer.alloc(4);
    header.writeUInt32LE(body.length, 0);
    const taken = takeFrame(Buffer.concat([header, body]));
    expect(taken?.frame.id).toBe(7);
    expect(taken?.frame.kind).toBe(2);
  });
});

describe("고장 난 엔진", () => {
  it.skipIf(!canSpawnScript)("즉시 죽으면 TypeScript 로 되돌아간다", async () => {
    process.env.PARISM_REGEX_BIN = FAKE_BIN;
    process.env.FAKE_NATIVE_MODE = "exit";
    resetNativeRegex();
    const fallbacks: RegexFallback[] = [];
    const result = await findAllRanges("a+", "aaa", "g", { onFallback: f => fallbacks.push(f) });
    expect(result.engine).toBe("typescript");
    expect(result.value.length).toBe(1);
    expect(fallbacks.length).toBeGreaterThan(0);
  });

  it.skipIf(!canSpawnScript)("잘린 프레임은 예외를 밖으로 던지지 않는다", async () => {
    /**
     * 이전에는 여기서 `RangeError` 가 stdout 핸들러 안에서 났고 **Node 가 죽었다.**
     * 지금은 명확한 오류로 바뀌고 요청은 실패로 돌아간다.
     */
    process.env.PARISM_REGEX_BIN = FAKE_BIN;
    process.env.FAKE_NATIVE_MODE = "truncated";
    /** 침묵하면 기다릴 수 없다 — 시간제한을 짧게 둔다. */
    process.env.PARISM_REGEX_TIMEOUT_MS = "300";
    resetNativeRegex();
    const fallbacks: RegexFallback[] = [];
    const result = await findAllRanges("a+", "aaa", "g", { onFallback: f => fallbacks.push(f) });
    expect(result.engine).toBe("typescript");
    expect(fallbacks.length).toBeGreaterThan(0);
    expect(fallbacks[0]!.reason).toMatch(/truncated|timed out/);
  });

  it.skipIf(!canSpawnScript)("길이가 어긋난 프레임도 조용히 넘어가지 않는다", async () => {
    process.env.PARISM_REGEX_BIN = FAKE_BIN;
    process.env.FAKE_NATIVE_MODE = "bad-length";
    resetNativeRegex();
    const fallbacks: RegexFallback[] = [];
    const result = await findAllRanges("a+", "aaa", "g", { onFallback: f => fallbacks.push(f) });
    expect(result.engine).toBe("typescript");
    expect(fallbacks.length).toBeGreaterThan(0);
  });

  it.skipIf(!canSpawnScript)("아무도 기다리지 않는 프레임은 무시해도 된다", async () => {
    process.env.PARISM_REGEX_BIN = FAKE_BIN;
    process.env.FAKE_NATIVE_MODE = "unknown-id";
    resetNativeRegex();
    const result = await findAllRanges("a+", "aaa", "g");
    /** 모르는 id 프레임을 건너뛰고 제대로 된 응답을 받아야 한다. */
    expect(result.engine).toBe("rust");
    /** 가짜 엔진은 매칭 0건이라고 답한다. */
    expect(result.value.length).toBe(0);
  });

  it.skipIf(!canSpawnScript)("엔진이 죽은 뒤에는 다시 쓰지 않는다", async () => {
    process.env.PARISM_REGEX_BIN = FAKE_BIN;
    process.env.FAKE_NATIVE_MODE = "exit";
    resetNativeRegex();
    await findAllRanges("a+", "aaa", "g");
    /** 두 번째 호출은 죽은 엔진을 건드리지 않고 바로 되돌아간다. */
    const again = await findAllRanges("a+", "aaa", "g");
    expect(again.engine).toBe("typescript");
  });

  it.skipIf(!canSpawnScript)("엔진의 표준 오류는 프로토콜을 깨지 않는다", async () => {
    /**
     * 엔진이 표준 오류에 써도 **MCP 표준 입출력과 섞이면 안 된다.**
     * 섞이면 프로토콜이 깨져 응답을 못 읽는다.
     */
    process.env.PARISM_REGEX_BIN = FAKE_BIN;
    process.env.FAKE_NATIVE_MODE = "stderr";
    resetNativeRegex();
    const engine = loadNativeRegex();
    expect(engine).toBeDefined();
    const result = await findAllRanges("a+", "aaa", "g");
    /** 잡음이 있어도 응답은 정상적으로 읽혀야 한다. */
    expect(result.engine).toBe("rust");
    /** 잡음은 따로 모아둔다 — 진단용. */
    expect(engine!.stderr()).toContain("fake engine noise");
  });
});

describe("닫힌 엔진", () => {
  it("닫은 뒤에는 요청이 즉시 실패한다", async () => {
    const engine = loadNativeRegex();
    if (!engine) return;
    engine.close();
    await expect(engine.findAll("a+", "aaa")).rejects.toThrowError(NativeUnavailableError);
  });
});
