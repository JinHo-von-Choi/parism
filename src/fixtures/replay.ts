/**
 * fixture 오프라인 replay — 계획서 8장
 *
 *   "새 파서 버전은 고정 fixture를 오프라인 replay 하여 값, 누락 내역, 근거, 예외를 비교한다.
 *    배포 전에 승인된 fixture 집합의 의도치 않은 계약 변화가 0 인지 확인한다.
 *    test 가 임의 expected 를 자동 덮어 써서 '통과'하도록 만들지 않는다."
 *
 * ## 통과/실패가 아니라 '무엇이 바뀌었는지'
 *
 * `runFixtureTests` 는 `JSON.stringify` 가 같은지만 본다. 같으면 pass, 다르면 fail 이고
 * 어디가 달라졌는지는 사람이 결과물을 뒤져 봐야 한다. 그게 수백 개 fixture 가 쌓일 때
 * 병목이 된다.
 *
 * 여기는 **변화된 경로 목록**을 돌려준다. "바뀌었다" 가 아니라 "`/entries/0/size_bytes` 가
 * 0 → 1 로 바뀌었다" 가 결과다. 배포 전에 사람이 이것을 훑어 의도한 변화만 승인하면 된다.
 *
 * ## 이 모듈은 expected 를 절대 쓰지 않는다
 *
 * 기대값을 갱신하는 경로가 이 파일에 **없다**. 자동 갱신은 회귀를 숨기는 가장 싼 방법이다.
 * 검토가 필요한 상태는 `unreviewed` 로 남기고 사람이 직접 고치게 한다.
 */

import type { ParserRegistry } from "../parsers/registry.js";
import type { ParseContext } from "../parsers/registry.js";
import { isReviewed, type FixtureEvidenceSpan, type FixtureManifest } from "./manifest.js";

/** 한 곳이 어떻게 달라졌는지. */
export interface ContractChange {
  /** JSON Pointer 경로 */
  path:    string;
  kind:    "missing" | "extra" | "type" | "value";
  expected?: unknown;
  actual?:   unknown;
}

/** 포인터 이스케이프 — RFC 6901. 키에 `~` 나 `/` 가 들어가면 깨진다. */
function escapeToken(token: string | number): string {
  return String(token).replace(/~/g, "~0").replace(/\//g, "~1");
}

/** 값의 종류 — 배열과 객체는 같은지 따로 보아야 "빈 배열" 과 "누락" 을 구별할 수 있다. */
function kindOf(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

/**
 * 두 값을 구조적으로 비교해 달라진 경로를 모두 뽑는다.
 *
 * `JSON.stringify` 비교와 달리 **키 순서는 변화로 보지 않는다** — 파서가 객체 키 순서를
 * 바꿨다고 해서 계약이 바뀐 것은 아니기 때문이다. 순서만 바뀐 `git status` diff 0 수용 기준과도 맞는다.
 */
export function diffJson(expected: unknown, actual: unknown, base = ""): ContractChange[] {
  const changes: ContractChange[] = [];

  if (kindOf(expected) !== kindOf(actual)) {
    return [{ path: base || "/", kind: "type", expected: kindOf(expected), actual: kindOf(actual) }];
  }

  if (Array.isArray(expected) && Array.isArray(actual)) {
    const shared = Math.min(expected.length, actual.length);
    for (let i = 0; i < shared; i++) changes.push(...diffJson(expected[i], actual[i], `${base}/${i}`));
    for (let i = shared; i < expected.length; i++) {
      changes.push({ path: `${base}/${i}`, kind: "missing", expected: expected[i] });
    }
    for (let i = shared; i < actual.length; i++) {
      changes.push({ path: `${base}/${i}`, kind: "extra", actual: actual[i] });
    }
    return changes;
  }

  if (expected !== null && actual !== null && typeof expected === "object" && typeof actual === "object") {
    const e = expected as Record<string, unknown>;
    const a = actual as Record<string, unknown>;
    for (const key of Object.keys(e)) {
      const path = `${base}/${escapeToken(key)}`;
      if (!Object.hasOwn(a, key)) changes.push({ path, kind: "missing", expected: e[key] });
      else changes.push(...diffJson(e[key], a[key], path));
    }
    for (const key of Object.keys(a)) {
      if (!Object.hasOwn(e, key)) changes.push({ path: `${base}/${escapeToken(key)}`, kind: "extra", actual: a[key] });
    }
    return changes;
  }

  /** 숫자는 NaN 을 서로 다른 값으로 보지 않는다 — 둘 다 숫자가 아니라는 뜻이 같으므로. */
  const sameNumber = typeof expected === "number" && typeof actual === "number"
    && Number.isNaN(expected) && Number.isNaN(actual);
  if (expected !== actual && !sameNumber) {
    changes.push({ path: base || "/", kind: "value", expected, actual });
  }
  return changes;
}

export type ReplayStatus = "match" | "changed" | "unreviewed" | "invalid";

/** 기대값 하나가 실제로 무엇을 담고 있는지. */
export interface ReplayCheck {
  name:     "parsed" | "evidence" | "failure" | "omission";
  status:   "match" | "changed" | "not_expected" | "not_checked";
  changes:  ContractChange[];
  /** 확인하지 못한 이유. 못 했는데 통과한 것처럼 보이면 안 된다. */
  reason?:  string;
}

export interface ReplayResult {
  id:       string;
  command:  string;
  /** 사람이 검토한 기대값이 있는가. 없으면 '계약'이 아니라 '제안' 이다. */
  reviewed: boolean;
  status:   ReplayStatus;
  /** 의도치 않은 계약 변화 수. 배포 판단에 쓰는 숫자다. */
  changes:  number;
  checks:   ReplayCheck[];
  /** 파서가 threw 하면 여기로 온다. 실패 계약과 비교해야 하므로 삼키지 않는다. */
  threw?:   string;
}

export interface ReplayOptions {
  maxItems?:      number;
  strictSchemas?: boolean;
  /** 파서 단계의 근거를 검증할지. 기본 true. */
  checkEvidence?: boolean;
}

/**
 * 기대 span 을 비교 가능한 형태로 접는다.
 *
 * **기대값에 적힌 필드만 남긴다.** `record` 를 적지 않은 기대 span 이 실제의 `record: 1` 과
 * 다르다고 실패하면, 손으로 적은 기대값을 쓸 수 없게 된다. 적지 않은 필드는
 * 이 fixture 가 검증하지 않는다는 뜻이다 — 그래서 범위를 좁힌 것이 아니라 밝힌 것이다.
 * 전수 대조가 필요하면 기대 span 에 필드를 빠짐없이 적으면 된다.
 */
function normalizeSpans(spans: readonly FixtureEvidenceSpan[] | undefined): unknown {
  return (spans ?? []).map(s => {
    const out: Record<string, unknown> = { source: s.source, line: s.line, start: s.start, end: s.end };
    if (s.record !== undefined) out.record = s.record;
    if (s.transform !== undefined) out.transform = s.transform;
    return out;
  });
}

/** 실제 근거에서 기대값이 적은 필드만 뽑아 비교한다. */
function pickFields(actual: unknown, template: unknown): unknown {
  if (Array.isArray(template)) {
    return Array.isArray(actual) ? actual.map((a, i) => pickFields(a, template[i])) : actual;
  }
  if (template !== null && typeof template === "object" && actual !== null && typeof actual === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(template as Record<string, unknown>)) {
      out[key] = pickFields((actual as Record<string, unknown>)[key], (template as Record<string, unknown>)[key]);
    }
    return out;
  }
  return actual;
}

/**
 * fixture 하나를 현재 파서로 되돌린다.
 *
 * 명령을 다시 실행하지 않는다 — 저장된 stdout 만 쓴다. 실행하면 그때의 환경이 섞여
 * "파서가 바뀌었다" 와 "기계가 바뀌었다" 를 구분할 수 없게 된다.
 */
export function replayManifest(manifest: FixtureManifest, registry: ParserRegistry, options: ReplayOptions = {}): ReplayResult {
  const ctx: ParseContext = { maxItems: options.maxItems ?? 200_000, format: "json" };
  const expected = manifest.expected;
  const checks: ReplayCheck[] = [];
  let threw: string | undefined;

  let parsed: unknown;
  let failureReason: string | undefined;
  let evidence: Record<string, unknown[]> = {};

  try {
    const result = registry.parseWithFallbackWithEvidence(
      manifest.tool.command, manifest.tool.args, manifest.stdout, ctx, options.strictSchemas ?? false,
    );
    parsed = result.parsed;
    failureReason = result.parse_error?.reason;
    evidence = result.evidence as Record<string, unknown[]>;
  } catch (err) {
    threw = err instanceof Error ? err.message : String(err);
  }

  /** 1. 실패 계약 — "이 입력은 성공하면 안 된다" 를 성립시키는 것이 실패 계약이다. */
  if (expected?.failure) {
    const matched = failureReason === expected.failure.reason || threw !== undefined;
    checks.push({
      name:   "failure",
      status: matched ? "match" : "changed",
      changes: matched ? [] : [{
        path: "/failure/reason", kind: "value",
        expected: expected.failure.reason, actual: failureReason ?? `(예외: ${threw ?? "없음"})`,
      }],
    });
  } else {
    checks.push({
      name: "failure", status: "not_expected", changes: [],
      reason: "기대 실패가 없다 — 성공해야 하는 fixture 다",
    });
  }

  /** 2. 값 — 통째로 비교한다. 부분 저장으로 바꾸면 무엇이 검증되는지 흐려진다. */
  if (threw === undefined && expected?.parsed !== undefined) {
    const changes = diffJson(expected.parsed, parsed);
    checks.push({ name: "parsed", status: changes.length === 0 ? "match" : "changed", changes });
  } else {
    checks.push({
      name: "parsed", status: "not_expected", changes: [],
      reason: threw !== undefined ? `파서가 예외를 던졌다: ${threw}` : "기대 파싱 결과가 없다 — 재생만 한다",
    });
  }

  /** 3. 근거 — '이 포인터는 원문 이 구간에서 왔다' 는 주장을 확인한다. */
  if (options.checkEvidence !== false && expected?.evidence) {
    const { pointers, exhaustive } = expected.evidence;
    const changes: ContractChange[] = [];
    for (const [pointer, spans] of Object.entries(pointers)) {
      /** 포인터는 이미 JSON Pointer 다. 밑에 붙일 때 다시 이스케이프하면 `/entries/0/path` 가 깨진다. */
      const at = `/evidence${pointer}`;
      const actualSpans = evidence[pointer];
      if (actualSpans === undefined) {
        changes.push({ path: at, kind: "missing", expected: normalizeSpans(spans) });
        continue;
      }
      changes.push(...diffJson(normalizeSpans(spans), pickFields(actualSpans, normalizeSpans(spans)), at));
    }
    /** 전수 확인을 켠 경우에만, 적어 두지 않은 포인터까지 변화로 센다. */
    if (exhaustive === true) {
      for (const pointer of Object.keys(evidence)) {
        if (!Object.hasOwn(pointers, pointer)) {
          changes.push({ path: `/evidence${pointer}`, kind: "extra", actual: evidence[pointer] });
        }
      }
    }
    checks.push({ name: "evidence", status: changes.length === 0 ? "match" : "changed", changes });
  }

  /**
   * 4. 누락 내역 — 여기서는 재현하지 않는다.
   *
   * 누락은 예산 층이 만들고 그 층은 **실제 응답 표면**을 재서 결정한다.
   * 저장된 stdout 을 파서 되짚는 replay 경로에는 그 표면이 없다.
   * 숫자를 지어내지 않고 '확인하지 못했다' 고 남긴다.
   */
  if (expected?.omission) {
    checks.push({
      name: "omission", status: "not_checked", changes: [],
      reason: "누락 내역은 실제 응답 표면을 재야 결정된다 — 저장된 stdout 을 되짚는 replay 에서는 확인하지 못했다",
    });
  }

  const changes = checks.reduce((sum, c) => sum + c.changes.length, 0);
  const reviewed = isReviewed(manifest);
  const status: ReplayStatus = !reviewed ? "unreviewed" : changes > 0 ? "changed" : "match";

  return { id: manifest.id, command: manifest.tool.command, reviewed, status, changes, checks, ...(threw !== undefined && { threw }) };
}

/** 변화가 있는 것만 사람이 볼 수 있는 한 줄로 접는다. */
export function formatChanges(result: ReplayResult, limit = 20): string[] {
  const lines: string[] = [];
  for (const check of result.checks) {
    if (check.changes.length === 0) continue;
    lines.push(`  [${check.name}] ${check.changes.length}건`);
    for (const c of check.changes.slice(0, limit)) {
      lines.push(`    ${c.path}  ${c.kind}  기대 ${JSON.stringify(c.expected)} → 실제 ${JSON.stringify(c.actual)}`);
    }
    if (check.changes.length > limit) lines.push(`    … 외 ${check.changes.length - limit}건`);
  }
  return lines;
}
