/**
 * 외부 파서 샌드박스 시험 — TypeScript 쪽.
 *
 * ## Rust 쪽 시험과 다른 점
 *
 * `crates/parism-sandbox/tests/sandbox.rs` 가 **샌드박스 안의 경계**를 증명한다면,
 * 이 파일은 **parism 이 그 샌드박스를 어떻게 부르는지** 를 증명한다.
 *
 * - 다리가 샌드박스를 실제로 띄워 게스트를 부르는가.
 * - capability 맵이 비어 있으면 게스트가 파일을 못 읽는가.
 * - 게스트가 시크릿의 **존재 여부만** 받는가.
 * - 팩 디렉터리에 `parser.wasm` 이 있으면 샌드박스 경로로 들어가는가.
 *
 * ## 게스트 컴포넌트와 바이너리가 없으면
 *
 * **건너뛴다.** 샌드박스가 없으면 아무것도 증명하지 못한다 —
 * 조용히 통과시키는 것은 통과와 다르다. Rust 쪽 시험과 같은 규칙이다.
 *
 * 작성자: 최진호
 * 작성일: 2026-10-22
 */

import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { chmodSync, copyFileSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir }                              from "node:os";
import { join, resolve }                       from "node:path";

import { runSandboxed, resolveSandboxBinary, resetSandboxProcess } from "../../src/parsers/external/sandbox.js";
import { isSandboxPack, loadSandboxedPack }                        from "../../src/parsers/external/sandboxed.js";
import { loadIsolatedPack }                                        from "../../src/parsers/external/host.js";
import { UnrecognizedOutputError }                                 from "../../src/parsers/registry.js";

/** 저장소 루트. */
const repoRoot = resolve(new URL("../..", import.meta.url).pathname);

/** 시험용 게스트 컴포넌트. */
const COMPONENT = join(repoRoot, "crates", "parism-sandbox", "tests", "fixtures", "sandbox-guest.component.wasm");

/** 샌드박스가 준비됐는지. */
const ready = existsSync(COMPONENT) && resolveSandboxBinary() !== undefined;

if (!ready) {
  console.warn(
    "[parism] 외부 파서 샌드박스 시험을 건너뛴다 — 게스트 컴포넌트와 샌드박스 바이너리가 없다.\n" +
    "만드는 방법: cargo build --release --manifest-path crates/parism-sandbox/Cargo.toml && node scripts/build-sandbox-guest.mjs",
  );
}

describe("외부 파서 샌드박스", () => {
  beforeAll(() => {
    if (!ready) return;
    /** 이 호스트에 있는 게스트 컴포넌트를 가리킨다. */
    process.env.PARISM_SANDBOX_BIN = resolveSandboxBinary();
  });

  afterAll(() => {
    resetSandboxProcess();
    delete process.env.PARISM_SANDBOX_BIN;
  });

  it.skipIf(!ready)("게스트를 부르면 결과를 돌려준다", () => {
    const result = runSandboxed({ component: COMPONENT, raw: "안녕", timeoutMs: 2000 });
    expect(result.ok).toBe(true);
    expect(result.value).toContain("안녕");
  });

  it.skipIf(!ready)("capability 맵이 비어 있으면 게스트는 파일을 못 읽는다", () => {
    const result = runSandboxed({ component: COMPONENT, raw: "read-file:/etc/passwd", timeoutMs: 2000 });
    expect(result.ok).toBe(true);
    expect(result.value).toContain("\"ok\":false");
    /** 파일 내용이 새면 안 된다. */
    expect(result.value).not.toContain("root:");
  });

  it.skipIf(!ready)("게스트는 시크릿의 존재 여부만 받는다", () => {
    const result = runSandboxed({
      component: COMPONENT,
      raw: "secret:OPENAI_API_KEY",
      timeoutMs: 2000,
      secrets: ["OPENAI_API_KEY"],
    });
    expect(result.ok).toBe(true);
    expect(result.value).toContain("\"exists\":true");
    /** 값이 아니라 존재 여부만. */
    expect(result.value).not.toContain("sk-");
  });

  it.skipIf(!ready)("무한 루프는 상한 시간 안에 멈춘다", () => {
    const result = runSandboxed({ component: COMPONENT, raw: "spin:", timeoutMs: 300 });
    expect(result.ok).toBe(false);
    expect(["timeout", "out_of_fuel"]).toContain(result.failure);
  });

  it.skipIf(!ready)("메모리 상한을 넘으면 멈춘다", () => {
    const result = runSandboxed({
      component: COMPONENT,
      raw: "alloc:1048576",
      timeoutMs: 5000,
      memoryBytes: 2 * 1024 * 1024,
    });
    expect(result.ok).toBe(false);
    expect(result.failure).toBe("out_of_memory");
  });

  it.skipIf(!ready)("샌드박스 바이너리가 없으면 조용히 넘어가지 않는다", () => {
    const before = process.env.PARISM_SANDBOX_BIN;
    process.env.PARISM_SANDBOX_BIN = "/nonexistent/parism-sandbox";
    resetSandboxProcess();
    try {
      const result = runSandboxed({ component: COMPONENT, raw: "안녕", timeoutMs: 500 });
      expect(result.ok).toBe(false);
      expect(result.failure).toBe("unavailable");
      expect(result.message).toContain("샌드박스");
    } finally {
      if (before === undefined) delete process.env.PARISM_SANDBOX_BIN;
      else process.env.PARISM_SANDBOX_BIN = before;
      resetSandboxProcess();
    }
  });
});

describe("샌드박스 팩 경로 선택", () => {
  it("parser.wasm 이 없으면 샌드박스 팩이 아니다", () => {
    const dir = mkdtempSync(join(tmpdir(), "parism-sandbox-pack-"));
    try {
      expect(isSandboxPack(dir)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("parser.wasm 이 있으면 샌드박스 팩이다", () => {
    const dir = mkdtempSync(join(tmpdir(), "parism-sandbox-pack-"));
    try {
      writeFileSync(join(dir, "parser.wasm"), "not a real component");
      expect(isSandboxPack(dir)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("샌드박스 팩은 contract.json 이 없으면 이유를 알린다", () => {
    const dir = mkdtempSync(join(tmpdir(), "parism-sandbox-pack-"));
    try {
      writeFileSync(join(dir, "parser.wasm"), "not a real component");
      expect(() => loadSandboxedPack(dir, 500)).toThrow(/contract\.json/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("loadIsolatedPack 은 parser.wasm 이 있으면 샌드박스 경로를 고른다", () => {
    const dir = mkdtempSync(join(tmpdir(), "parism-sandbox-pack-"));
    try {
      writeFileSync(join(dir, "parser.wasm"), "not a real component");
      /** 계약 파일이 없으므로 여기서 실패한다 — 워커 경로가 아니라 샌드박스 경로로 갔다는 증거다. */
      expect(() => loadIsolatedPack(dir, { timeLimitMs: 500, memoryLimitMb: 128 })).toThrow(/contract\.json/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("샌드박스 팩 — 끝까지", () => {
  /** 실제 컴포넌트를 가진 팩 디렉터리를 만든다. */
  function writeRealPack(): string {
    const dir = mkdtempSync(join(tmpdir(), "parism-sandbox-real-"));
    copyFileSync(COMPONENT, join(dir, "parser.wasm"));
    writeFileSync(join(dir, "contract.json"), JSON.stringify({
      name: "demo-pack",
      acceptedFlags: { "-b": "bool" },
      requiredFlags: ["-b"],
      acceptedValues: { "--output": "NAME,SIZE" },
      rowsKey: "entries",
      rowFields: ["name"],
      headerLines: 1,
    }));
    return dir;
  }

  it.skipIf(!ready)("팩을 불러 계약까지 읽는다", () => {
    const dir = writeRealPack();
    try {
      const pack = loadSandboxedPack(dir, 2000);
      expect(pack.name).toBe("demo-pack");
      expect(pack.contract.requiredFlags).toEqual(["-b"]);
      expect(pack.contract.acceptedValues?.["--output"]).toBeInstanceOf(RegExp);
      expect(pack.contract.rowsKey).toBe("entries");
      expect(pack.contract.headerLines).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it.skipIf(!ready)("팩을 부르면 파싱된 결과가 돌아온다", async () => {
    const dir = writeRealPack();
    try {
      const pack = loadSandboxedPack(dir, 2000);
      const result = pack.parse(["-b"], "안녕", undefined, false);
      expect(result.parsed).toBeDefined();
      expect(JSON.stringify(result.parsed)).toContain("안녕");
      await pack.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it.skipIf(!ready)("게스트가 모르는 형식이라고 하면 인식 실패로 분류한다", () => {
    const dir = writeRealPack();
    try {
      const pack = loadSandboxedPack(dir, 2000);
      /** 게스트의 오류가 **그대로** 전달되어야 한다. */
      expect(() => pack.parse([], "fail:unknown layout", undefined, false)).toThrow(UnrecognizedOutputError);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it.skipIf(!ready)("샌드박스가 실패하면 이유를 알린다", () => {
    const dir = writeRealPack();
    try {
      const pack = loadSandboxedPack(dir, 2000);
      /** 무한 루프는 연료로 멈춘다 — 조용히 빈 결과가 되지 않는다. */
      expect(() => pack.parse([], "spin:", undefined, false)).toThrow(/demo-pack/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("샌드박스 프로세스 장애", () => {
  const original = process.env.PARISM_SANDBOX_BIN;

  afterEach(() => {
    if (original === undefined) delete process.env.PARISM_SANDBOX_BIN;
    else process.env.PARISM_SANDBOX_BIN = original;
    resetSandboxProcess();
  });

  it("실행할 수 없는 바이너리면 조용히 넘어가지 않는다", () => {
    process.env.PARISM_SANDBOX_BIN = "/etc/hostname";
    resetSandboxProcess();
    const result = runSandboxed({ component: COMPONENT, raw: "안녕", timeoutMs: 500 });
    expect(result.ok).toBe(false);
    expect(result.failure).toBe("unavailable");
  });

  it("답하지 않는 프로세스는 시간 상한을 넘으면 실패한다", () => {
    const dir = mkdtempSync(join(tmpdir(), "parism-sandbox-silent-"));
    try {
      /** 아무것도 하지 않는 프로세스. 답하지 않는다. */
      const silent = join(dir, "silent");
      /**
       * `exec` 로 셸을 대체한다.
       * 안 그러면 손자(sleep)가 남아 **시험이 끝난 뒤에도 프로세스가 안 죽는다.**
       */
      writeFileSync(silent, "#!/bin/sh\nexec sleep 30\n");
      chmodSync(silent, 0o755);
      process.env.PARISM_SANDBOX_BIN = silent;
      resetSandboxProcess();
      const result = runSandboxed({ component: COMPONENT, raw: "안녕", timeoutMs: 300 });
      expect(result.ok).toBe(false);
      expect(result.failure).toBe("unavailable");
      expect(result.message).toContain("답하지 않았다");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("샌드박스 프로세스가 죽으면 다음 호출이 다시 띄운다", async () => {
    if (!ready) return;
    const first = runSandboxed({ component: COMPONENT, raw: "안녕", timeoutMs: 2000 });
    expect(first.ok).toBe(true);
    /** 프로세스를 끝내고 죽음이 반영될 때까지 기다린다. */
    resetSandboxProcess();
    await new Promise(resolve => setTimeout(resolve, 150));
    /** 새 프로세스가 떠서 다시 답해야 한다. */
    const again = runSandboxed({ component: COMPONENT, raw: "안녕", timeoutMs: 2000 });
    expect(again.ok).toBe(true);
  });

  it("바이너리가 없으면 undefined 다 — 조용히 다른 곳을 찾지 않는다", () => {
    process.env.PARISM_SANDBOX_BIN = "/nonexistent/parism-sandbox";
    expect(resolveSandboxBinary()).toBeUndefined();
  });
});
