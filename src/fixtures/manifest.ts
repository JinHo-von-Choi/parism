/**
 * fixture 매니페스트 — 계획서 8장 "기반 기능: 실패를 재현하는 parser test" 의 저장 형식.
 *
 *   "fixture manifest 에는 cmd / args 의 정제본, stdout / stderr 의 정제본, exit 상태,
 *    parser / content / schema 버전, 플랫폼 · 도구 버전, expected 값 · expected 실패 ·
 *    출처 span · 완전성 기대값을 둔다. 마스킹 때문에 바뀐 필드도 명시한다.
 *    자동으로 사용자 원문을 서버에 업로드하지 않는다."
 *
 * 기존 `Fixture { input, args, expected }` 는 입출력 쌍만 있었다. 기댓값이 왜 그 값인지,
 * 어떤 버전에서 만들어졌는지, 마스킹으로 무엇이 바뀌었는지 남지 않아
 * 사람이 검토한 기대값이 자산으로 누적되지 않았다. 이 형식은 그 빈칸을 채운다.
 *
 * ## 기대값은 사람이 검토해야만 '기대값'이 된다
 *
 * `expected.reviewed_by` 가 비면 그 fixture 는 **미검토** 다. replay 는 미검토 기대값과
 * 불일치해도 '계약을 어겼다고' 단정하지 않고 "검토가 필요하다" 고만 말한다.
 * 자동화된 대로 기대값을 덮어 써 통과시키지 않는다 — 그건 회귀를 숨기는 가장 싼 방법이다.
 */

import { z } from "zod";
import { hashContent } from "../engine/evidence.js";
import { PACKAGE_VERSION } from "../server.js";

/** 매니페스트 형식 버전. 필드를 더할 때도 이 값은 올리고 이전 판독 경로를 함께 둔다. */
export const FIXTURE_MANIFEST_VERSION = 1;

/**
 * 마스킹으로 바뀐 곳.
 *
 * "마스킹 때문에 바뀐 필드도 명시한다" 를 이렇게 남긴다 — 무슨 패턴이 몇 번 바뀌었는지,
 * 그리고 **바뀌었다는 사실 자체**를 남긴다. 무언가를 지운 흔적이 없으면
 * 나중에 그게 원래 없던 것인지 가린 것인지 구분할 수 없다.
 */
export const redactionSchema = z.object({
  /** 왜 가렸는지 */
  kind:     z.enum(["secret", "home_path", "argv_secret"]),
  /** 가린 대상을 복원할 수 있게 남기는 표시자 */
  pattern:  z.string(),
  /** 몇 번 가렸는지 */
  count:    z.number().int().nonnegative(),
});
export type FixtureRedaction = z.infer<typeof redactionSchema>;

/**
 * 완전성 기대값.
 * `unknown` 은 세 값 중 하나로 정직하게 남는다 — 확인하지 못한 것을 false 로 쓰지 않기 위해.
 */
export const completenessSchema = z.object({
  source_complete:          z.union([z.boolean(), z.literal("unknown")]).optional(),
  parse_complete:           z.union([z.boolean(), z.literal("unknown")]).optional(),
  representation_lossless:  z.union([z.boolean(), z.literal("unknown")]).optional(),
});
export type FixtureCompleteness = z.infer<typeof completenessSchema>;

/**
 * 출처 span 기대값.
 *
 * **여기 기록하는 것은 파서 단계의 근거다** — `RawSpan` 과 같은 형태다.
 * 줄 번호(1부터) + 그 줄 안의 UTF-16 구간 `[start, end)`.
 *
 * 엔진이 노출하는 `review` 쪽 `source_spans` 는 **UTF-8 바이트 오프셋**이라 표기가 다르다
 * (SPECIFICATION 5.2.0). 둘을 같은 것으로 기록하면 나중에 어느 표를 검증한지 알 수 없어진다.
 * fixture 가 검증하는 것은 replay 가 되짚을 수 있는 쪽, 즉 여기의 형태다.
 * `transform` 이 없으면 원문 그대로(verbatim), 있으면 계산한 값(derived)이다.
 */
export const evidenceSpanSchema = z.object({
  source:    z.enum(["stdout", "stderr"]),
  line:      z.number().int().nonnegative(),
  start:     z.number().int().nonnegative(),
  end:       z.number().int().nonnegative(),
  record:    z.number().int().nonnegative().optional(),
  transform: z.string().optional(),
});
export type FixtureEvidenceSpan = z.infer<typeof evidenceSpanSchema>;

export const expectedSchema = z.object({
  /** 기대 파싱 결과. 통째로 저장한다 — 부분 저장으로 바꾸면 무엇이 검증되는지 흐려진다. */
  parsed:       z.unknown().optional(),
  /** 기대 실패 계약. "이 입력은 성공하면 안 된다" 를 성립시키는 것이 실패 계약이다. */
  failure:      z.object({ reason: z.string(), message: z.string().optional() }).optional(),
  /** 기대 누락 내역. 조용히 사라지는 것을 허용하지 않으므로 생략 수까지 적는다. */
  omission:     z.object({ rows_omitted: z.number().int().nonnegative() }).optional(),
  /**
   * 기대 근거. JSON Pointer -> 출처 구간.
   *
   * **적을 나열한 포인터만 확인한다.** 파서가 더 많은 포인터를 낸다고 실패가 되지 않는다.
   * 사람이 검토할 수 있는 것은 '내가 본 이 주장' 이지 '파서가 낼 수 있는 모든 주장' 이 아니기 때문이다.
   * 전수 확인이 필요하면 아래 `exhaustive` 를 켠다.
   */
  evidence:     z.object({
    pointers:  z.record(z.string(), z.array(evidenceSpanSchema)),
    /** true 면 파서가 낸 포인터가 이 목록에 없는 것까지 변화로 센다. 기본 false. */
    exhaustive: z.boolean().optional(),
  }).optional(),
  completeness: completenessSchema.optional(),
  /**
   * 이 기대값을 검토한 사람.
   *
   * **선택 사항인 이유**: 필수로 두면 '기대값은 썼지만 아직 아무도 보지 않았다' 는 상태를
   * 표현할 수 없고, 그 상태의 fixture 는 매니페스트 검증에서 탈락해 조용히 사라진다.
   * 기고자가 초안으로 먼저 담아두고, 사람이 보고 이름을 남기는 것이 실제 흐름이다.
   * 비면 **미검토** 다 — replay 는 이를 계약 위반으로 세지 않는다.
   *
   * 기계는 expected 를 절대 다시 쓰지 않는다.
   */
  reviewed_by:  z.string().min(1).optional(),
  reviewed_at:  z.string().optional(),
  /** 왜 이 값이 맞는지 한 줄. 나중에 이상하면 사람에게 물을 수 있어야 한다. */
  note:         z.string().optional(),
});
export type FixtureExpected = z.infer<typeof expectedSchema>;

export const fixtureManifestSchema = z.object({
  manifest_version: z.literal(FIXTURE_MANIFEST_VERSION),
  /** 안정 식별자. 파일명이 아니라 이 값을 쓴다 — 이름을 바꿔도 같은 fixture 다. */
  id:           z.string().min(1),
  captured_at:  z.string().min(1),

  /** 대상 명령의 정제본 */
  tool: z.object({
    command:      z.string().min(1),
    args:         z.array(z.string()),
    /** 인자에 시크릿이 들어갔는지 여부. 인자 자체는 공개하지 않는다. */
    args_redacted: z.boolean().optional(),
  }),

  /** 실행 결과 */
  exit: z.object({
    code:   z.number().int(),
    signal: z.string().nullable().optional(),
  }),

  /** stdout / stderr 의 정제본 */
  stdout: z.string(),
  stderr: z.string(),

  /** 이 정제본의 지문. stdout 이 바뀌면 content_hash 가 바뀌어 fixture 가 어긋났음을 안다. */
  content_hash: z.string().min(1),

  /** 이 정제본을 만든 환경 */
  versions: z.object({
    /** parism 자체 버전 */
    parism:      z.string().optional(),
    /** 기대값을 낼 때 쓴 파서 버전 */
    parser:      z.string().optional(),
    /** 파싱 결과의 봉투 스키마 버전 */
    schema:      z.string().optional(),
    platform:    z.string().optional(),
    /** 대상 도구 자체의 버전(예: "git 2.43.0"). 파서가 아니라 명령을 구분하는 값이다. */
    tool_version: z.string().optional(),
  }),

  /** 마스킹으로 바뀐 곳 */
  redactions: z.array(redactionSchema).default([]),

  /** 사람이 검토한 기대값. 없으면 이 fixture 는 재생만 한다. */
  expected: expectedSchema.optional(),
});
export type FixtureManifest = z.infer<typeof fixtureManifestSchema>;

export interface ManifestValidation {
  ok:      boolean;
  manifest?: FixtureManifest;
  /** 사람이 읽을 수 있는 이유 목록. 조용히 버리지 않는다. */
  issues:  string[];
}

/**
 * 매니페스트를 검증한다.
 *
 * 실패하면 조용히 버리지 않고 이유를 돌려준다 — 깨진 fixture 를 조용히 건너뛰면
 * '회귀 0건' 이라는 거짓말이 된다.
 */
export function validateManifest(input: unknown): ManifestValidation {
  const result = fixtureManifestSchema.safeParse(input);
  if (result.success) return { ok: true, manifest: result.data, issues: [] };
  return {
    ok:     false,
    issues: result.error.issues.map(i => (i.path.length > 0 ? `${i.path.join(".")}: ${i.message}` : i.message)),
  };
}

/** 사람이 검토했는가 — 미검토 기대값은 '계약'이 아니라 '제안' 이다. */
export function isReviewed(manifest: FixtureManifest): boolean {
  return typeof manifest.expected?.reviewed_by === "string" && manifest.expected.reviewed_by.length > 0;
}

/** 현재 stdout 문자열의 지문을 다시 낸다. fixture 가 편집되었는지 확인하는 데 쓴다. */
export function contentHashOf(stdout: string): string {
  return hashContent(stdout);
}

/** 매니페스트를 만들 때 기본으로 넣는 값들. 호출자가 Environment info 를 덧댄다. */
export function baseVersions(): FixtureManifest["versions"] {
  return { parism: PACKAGE_VERSION, schema: String(FIXTURE_MANIFEST_VERSION) };
}
