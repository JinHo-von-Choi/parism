/**
 * 바이트 동일성 시험 — 정규식 엔진 교체 게이트.
 *
 * ## 이 시험이 막는 것
 *
 * Rust 정규식 엔진을 켰을 때 **출력이 한 바이트라도 달라지면 출시하지 않는다.**
 * 계획서 TASK-027 / REQ-009 / PAT-002 의 요구다.
 *
 * ## 이 시험이 막지 못하는 것
 *
 * **비교할 것이 없는 통과.** 두 엔진의 결과가 원래부터 같으면 무조건 통과한다.
 * `parism test` 코퍼스 27 fixture / 2,591 바이트에는 기본 리댁션 패턴이 **한 번도 걸리지 않는다**(실측).
 * 그 상태로 비교하면 Rust 를 한 번도 안 돌려도 통과한다.
 *
 * 그래서 이 시험은 결과만 보지 않는다.
 *
 * - `rustEngaged` — Rust 엔진이 실제로 처리한 연산 수. 0 이면 **검증하지 못했다.**
 * - `redactions` — 실제로 뭔가를 가린 횟수. 0 이면 **비교할 것이 없었다.**
 *
 * 둘 다 0 이면 통과가 아니라 실패로 본다. Rust 바이너리가 없는 환경이라면
 * `PARISM_REQUIRE_NATIVE=1` 로 하드 실패를 걸 수 있다 — CI 가 그 변수를 켠다.
 *
 * 작성자: 최진호
 * 작성일: 2026-10-22
 */

import { describe, it, expect, beforeAll } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir }                       from "node:os";
import { join }                         from "node:path";

import {
  verifyByteIdentity,
  packFixtureCorpus,
  manifestCorpus,
  compareArtifacts,
  SECRET_CANARY_BLOCK,
  type ByteIdentityReport,
} from "../../src/engine/regex-byte-identity.js";
import { resolveNativeBinary }                      from "../../src/engine/regex-native.js";

/** Rust 바이너리가 있어야 Rust 경로를 검증할 수 있다. */
const nativeAvailable = resolveNativeBinary() !== undefined;

/** CI 는 Rust 바이너리가 없으면 실패해야 한다 — 없으면 검증한 것이 아니다. */
const requireNative = process.env.PARISM_REQUIRE_NATIVE === "1";

let report: ByteIdentityReport;

describe("바이트 동일성 — 정규식 엔진 교체 게이트", () => {
  beforeAll(async () => {
    /** 엔진 모드가 이미 설정돼 있는 상태로 돌려 본다 — 설정 복구 경로까지 확인한다. */
    process.env.PARISM_REGEX_ENGINE = "auto";
    try {
      report = await verifyByteIdentity({});
    } finally {
      delete process.env.PARISM_REGEX_ENGINE;
    }
  }, 120_000);

  it("Rust 엔진이 켜져도 출력이 한 바이트도 달라지지 않는다", () => {
    expect(
      report.mismatches,
      report.mismatches.map(m => `${m.label}\n${m.sample}`).join("\n\n"),
    ).toEqual([]);
  });

  it("비교한 대상이 있다 — 0 건이면 비교가 아니라 무의미한 통과다", () => {
    expect(report.comparisons).toBeGreaterThan(100);
    expect(report.bytes).toBeGreaterThan(0);
  });

  it("코퍼스는 `parism test` 가 되짚는 바로 그 fixture 다", () => {
    const packs = packFixtureCorpus();
    expect(packs.length).toBeGreaterThan(0);
    expect(report.corpus.packFixtures).toBe(packs.length);
    /** 라벨이 팩 이름을 드러내야 한다 — 어디서 온 데이터인지 알 수 있어야 한다. */
    expect(packs.every(p => p.label.startsWith("pack:"))).toBe(true);
  });

  it("manifest fixture 가 있으면 함께 비교한다", () => {
    const manifests = manifestCorpus();
    expect(report.corpus.manifestFixtures).toBe(manifests.length);
  });

  it("비교가 의미 있었다 — 패턴이 실제로 무언가를 가렸다", () => {
    expect(report.redactions).toBeGreaterThan(0);
  });

  it("Rust 엔진이 실제로 돌았다", () => {
    if (!nativeAvailable) {
      /**
       * 바이너리가 없으면 Rust 를 한 번도 못 돌린다.
       * 조용히 통과시키면 "검증했다" 고 잘못 말하게 된다.
       */
      expect(report.rustEngaged).toBe(0);
      if (requireNative) {
        throw new Error("PARISM_REQUIRE_NATIVE=1 이지만 Rust 정규식 바이너리를 찾을 수 없다 — 검증을 하지 못했다");
      }
      return;
    }
    expect(report.rustEngaged).toBeGreaterThan(0);
  });

  it("되돌아간 패턴은 이유와 함께 기록된다", () => {
    for (const fallback of report.fallbacks) {
      expect(fallback.pattern.length).toBeGreaterThan(0);
      expect(fallback.reason.length).toBeGreaterThan(0);
    }
  });
});

describe("비교가 무의미하지 않은지 — 코퍼스 자체의 성질", () => {
  it("비밀 형태 문자열이 기본 리댁션 패턴에 걸린다", () => {
    const patterns = [
      "sk-[A-Za-z0-9_-]{20,}",
      "ghp_[A-Za-z0-9]{30,}",
      "AKIA[0-9A-Z]{16}",
      "xox[baprs]-[A-Za-z0-9-]{10,}",
      "Bearer\\s+[A-Za-z0-9._-]+",
    ];
    let hits = 0;
    for (const pattern of patterns) {
      if (new RegExp(pattern, "g").test(SECRET_CANARY_BLOCK)) hits += 1;
    }
    expect(hits).toBeGreaterThan(0);
  });

  it("canary 에 BMP 밖 문자가 있다 — 좌표 변환이 틀려도 바이트 비교가 우연히 맞으면 안 된다", () => {
    /** U+1F389 는 UTF-16 에서 2 코드유닛, UTF-8 에서 4 바이트다. */
    expect(SECRET_CANARY_BLOCK).toMatch(/[\u{10000}-\u{10ffff}]/u);
  });

  it("원본 fixture 는 그대로 두고 파생 항목으로 따로 센다", () => {
    const packs = packFixtureCorpus();
    const originals = new Set(packs.map(p => p.text));
    /** 원본이 파생 항목에 섞여 들어가지 않았는지 확인한다. */
    expect(originals.has(SECRET_CANARY_BLOCK)).toBe(false);
  });
});

describe("바이트 비교 자체", () => {
  it("같은 산출물은 불일치가 아니다", () => {
    expect(compareArtifacts("같은 것", "abc", "abc")).toBeNull();
  });

  it("다른 산출물은 어디서 갈라졌는지 알려 준다", () => {
    const diff = compareArtifacts("다른 것", "abcdef", "abcXef");
    expect(diff).not.toBeNull();
    expect(diff!.label).toBe("다른 것");
    expect(diff!.sample).toContain("바이트 3");
  });

  it("길이가 다르면 어긋난 지점도 알려 준다", () => {
    const diff = compareArtifacts("길이 다름", "abc", "abcd");
    expect(diff).not.toBeNull();
    expect(diff!.sample).toContain("rust 3 바이트");
  });
});

describe("manifest 코퍼스", () => {
  it("디렉터리가 없으면 빈 목록이다 — 없는 게 정상이다", () => {
    expect(manifestCorpus("/nonexistent/parism-fixtures")).toEqual([]);
  });

  it("stdout 이 없거나 깨진 파일은 조용히 세지 않는다", () => {
    const dir = mkdtempSync(join(tmpdir(), "parism-fixt-ident-"));
    try {
      writeFileSync(join(dir, "good.json"), JSON.stringify({ stdout: "hello" }));
      writeFileSync(join(dir, "no-stdout.json"), JSON.stringify({ stderr: "x" }));
      writeFileSync(join(dir, "broken.json"), "{ 깨진 JSON");
      const items = manifestCorpus(dir);
      expect(items.length).toBe(1);
      expect(items[0]!.text).toBe("hello");
      expect(items[0]!.label).toContain("good.json");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
