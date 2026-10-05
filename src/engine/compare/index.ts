/**
 * 이미 존재하는 두 결과의 의미 diff.
 *
 * read 단계다. 새 명령을 실행하지 않고, 원격에 접속하지 않고, 감시 루프를 만들지 않는다.
 *
 * 가장 중요한 규칙 하나: **불완전 결과의 없는 행을 '삭제'라고 말하지 않는다.**
 * 수집이 잘렸거나 파서가 뭔가를 놓쳤다면, 보이지 않는 것은 사라진 것이 아니라 보이지 않은 것이다.
 *
 * 작성자: 최진호
 * 작성일: 2026-10-05
 */

import {
  compareFingerprints, type Compatibility, type Fingerprint,
} from "./fingerprint.js";
import {
  gitStatusIdentity, kubernetesIdentity, type RowIdentity,
} from "./identity.js";
import type { CompareOptions } from "./identity.js";

export type { CompareOptions } from "./identity.js";

/** 비교가 성립하는지, 그 이유 */
export interface CompareRefusals {
  comparable:     boolean;
  compatibility:  Compatibility;
  reasons:        string[];
  /** 대상 동일성에는 영향 없지만 무시한 차이 */
  ignored:        string[];
}

/** 필드 하나의 변화와 그 근거 */
export interface FieldChange {
  field:    string;
  before:   unknown;
  after:    unknown;
  /** 이전 결과에서 이 값의 근거 포인터 */
  base_pointer?:   string;
  /** 현재 결과에서 이 값의 근거 포인터 */
  current_pointer?: string;
}

export interface CompareRowResult {
  key:        string;
  status:     "added" | "removed" | "changed" | "unchanged";
  changes:    FieldChange[];
  base_pointer?:     string;
  current_pointer?: string;
}

export interface CompareResult {
  ok:            boolean;
  /** 비교가 성립했는지 */
  comparable:    boolean;
  refusals:      CompareRefusals;
  domain:        string;
  added:         CompareRowResult[];
  removed:       CompareRowResult[];
  changed:       CompareRowResult[];
  unchanged_count: number;
  /** 비교에서 뺀 필드. 사용자가 정한 것을 그대로 공개한다 */
  ignored_fields: string[];
  /** 결과가 불완전해 '없다'는 말을 하지 않은 곳 */
  partial:       { base_incomplete: boolean; current_incomplete: boolean; withheld_reasons: string[] };
  /** 같은 이름이 다르게 해석되는 등 키 충돌 */
  key_conflicts: Array<{ key: string; count: number }>;
  /** 비교하지 못한 이유(거부 사유) */
  refusal_reason?: string;
  message?:      string;
}

/** 비교에 쓸 한쪽 결과 */
export interface CompareSide {
  resultId:    string;
  fingerprint: Fingerprint;
  rows:        unknown[];
  /** 결과가 불완전했는지(수집 잘림·파서 실패·표현 손실) */
  incomplete:  boolean;
  incompleteReasons: string[];
  review:      { source_complete: true | false | "unknown"; parse_complete: true | false | "unknown" };
}

export interface CompareInput {
  base:    CompareSide;
  current: CompareSide;
  options?: CompareOptions;
  strict?:  boolean;
}

function rowsOf(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (typeof value !== "object" || value === null) return [];
  for (const inner of Object.values(value)) {
    if (Array.isArray(inner)) return inner;
  }
  /** compact 표는 rows 키를 쓴다 */
  /** compact 표 형식은 rows 키에 행이 있다 */
  const compactRows = (value as { rows?: unknown }).rows;
  return Array.isArray(compactRows) ? compactRows : [];
}

/** 결과가 어떤 명령의 것인지 보고 대가족을 정한다 */
export function domainOf(fingerprint: Fingerprint): string | null {
  if (fingerprint.cmd === "git") return "git";
  if (fingerprint.cmd === "kubectl") return "kubernetes";
  if (fingerprint.cmd === "ps") return "ps";
  return null;
}

export function compareResults(input: CompareInput): CompareResult {
  const options = input.options ?? {};
  const verdict = compareFingerprints(input.base.fingerprint, input.current.fingerprint, { strict: input.strict });

  const domain = domainOf(input.current.fingerprint);
  const ignored = options.ignore_fields ?? [];
  const baseRows    = rowsOf(input.base.rows);
  const currentRows = rowsOf(input.current.rows);

  const partial = {
    base_incomplete:    input.base.incomplete,
    current_incomplete: input.current.incomplete,
    withheld_reasons:   [...input.base.incompleteReasons, ...input.current.incompleteReasons],
  };

  const keyConflicts: CompareResult["key_conflicts"] = [];
  const empty: CompareResult = {
    ok: true, comparable: false,
    refusals: { comparable: false, compatibility: verdict.compatibility, reasons: verdict.reasons, ignored: verdict.ignored },
    domain: domain ?? "unknown", added: [], removed: [], changed: [], unchanged_count: 0,
    ignored_fields: ignored, partial, key_conflicts: [],
  };

  if (verdict.compatibility === "incompatible") {
    return { ...empty, refusal_reason: "different_subject", message: verdict.reasons.join("; ") };
  }
  if (verdict.compatibility === "unknown" && (input.strict || domain === null)) {
    return { ...empty, refusal_reason: "identity_unknown", message: verdict.reasons.join("; ") || "identity could not be confirmed" };
  }
  if (domain === null) {
    return { ...empty, refusal_reason: "domain_unsupported", message: `'${input.current.fingerprint.cmd}' has no comparison rules yet` };
  }
  if (domain === "ps") {
    /**
     * PID 만을 identity 로 삼으면 PID 재사용 때문에 '다른 프로세스' 를 '같은 프로세스' 로 본다.
     * 계획서가 보류를 지시했으므로 비교하지 않는다.
     */
    return { ...empty, refusal_reason: "domain_withheld", message: "ps comparison is withheld: PID alone is not identity (PID reuse)" };
  }

  const build = (side: CompareSide, rows: unknown[]): Map<string, { row: unknown; pointer: string; identity: RowIdentity }> => {
    const map = new Map<string, { row: unknown; pointer: string; identity: RowIdentity }>();
    for (let i = 0; i < rows.length; i++) {
      const identity = domain === "git"
        ? gitStatusIdentity(rows[i], side.fingerprint.cwd_real, options)
        : kubernetesIdentity(rows[i], side.fingerprint.context, options);
      if (!identity.trustworthy) continue;
      const pointer = `/${i}`;
      if (map.has(identity.key)) {
        const existing = keyConflicts.find(c => c.key === identity.key);
        if (existing) existing.count += 1; else keyConflicts.push({ key: identity.key, count: 2 });
        continue;
      }
      map.set(identity.key, { row: rows[i], pointer, identity });
    }
    return map;
  };

  const baseMap    = build(input.base, baseRows);
  const currentMap = build(input.current, currentRows);

  /** identity 를 만들지 못한 행이 있으면 그 수만큼 보류 이유를 적는다 */
  const untrustworthy = (side: CompareSide, rows: unknown[]): string[] => {
    const out: string[] = [];
    for (const row of rows) {
      const identity = domain === "git"
        ? gitStatusIdentity(row, side.fingerprint.cwd_real, options)
        : kubernetesIdentity(row, side.fingerprint.context, options);
      if (!identity.trustworthy && identity.reason) out.push(identity.reason);
    }
    return [...new Set(out)];
  };
  const untrustworthyBase    = untrustworthy(input.base, baseRows);
  const untrustworthyCurrent = untrustworthy(input.current, currentRows);
  partial.withheld_reasons.push(...untrustworthyBase, ...untrustworthyCurrent);

  /**
   * 어느 한쪽이라도 identity 를 확정하지 못한 행이 있으면 '추가'나 '삭제'를 단정하지 않는다.
   * 못 찾았다고 새로 생긴 것(또 사라진 것)이 아니기 때문이다.
   * 결과는 partial 로 남고 그 사실을 밝힌다.
   */
  const canClaimPresence = untrustworthyBase.length === 0 && untrustworthyCurrent.length === 0;

  if (keyConflicts.length > 0) {
    return {
      ...empty, comparable: false, key_conflicts: keyConflicts,
      refusal_reason: "duplicate_identity",
      message: `duplicate identity in ${keyConflicts.length} key(s); comparing would silently drop a row`,
    };
  }

  const added:   CompareRowResult[] = [];
  const removed: CompareRowResult[] = [];
  const changed: CompareRowResult[] = [];
  let   unchanged = 0;

  for (const [key, before] of baseMap) {
    const after = currentMap.get(key);
    if (!after) {
      /**
       * 여기서 "없다"를 "삭제"라고 부를 수 있는 조건은 두 가지다.
       * 현재 쪽이 완전해야 하고, 어느 쪽에서도 identity 를 놓친 행이 없어야 한다.
       * 하나라도 어기면 삭제로 단정하지 않는다.
       */
      if (input.current.incomplete) {
        partial.withheld_reasons.push(`withheld a missing row in the incomplete current result: ${key}`);
        continue;
      }
      if (!canClaimPresence) {
        partial.withheld_reasons.push(`withheld a removal claim: some rows could not be identified on either side`);
        continue;
      }
      removed.push({ key, status: "removed", changes: [], base_pointer: before.pointer });
      continue;
    }
    const changes = diffFields(before.row, after.row, ignored);
    if (changes.length === 0) { unchanged++; continue; }
    changed.push({
      key, status: "changed", changes,
      base_pointer: before.pointer, current_pointer: after.pointer,
    });
  }
  for (const [key, after] of currentMap) {
    if (baseMap.has(key)) continue;
    if (input.base.incomplete) {
      partial.withheld_reasons.push(`withheld an extra row in the incomplete base result: ${key}`);
      continue;
    }
    if (!canClaimPresence) {
      partial.withheld_reasons.push(`withheld an addition claim: some rows could not be identified on either side`);
      continue;
    }
    added.push({ key, status: "added", changes: [], current_pointer: after.pointer });
  }

  return {
    ok: true, comparable: true,
    refusals: { comparable: true, compatibility: verdict.compatibility, reasons: verdict.reasons, ignored: verdict.ignored },
    domain, added, removed, changed, unchanged_count: unchanged,
    ignored_fields: ignored, partial, key_conflicts: [],
  };
}

function diffFields(before: unknown, after: unknown, ignore: string[]): FieldChange[] {
  if (typeof before !== "object" || before === null || typeof after !== "object" || after === null) return [];
  const b = before as Record<string, unknown>;
  const a = after as Record<string, unknown>;
  const keys = [...new Set([...Object.keys(b), ...Object.keys(a)])].filter(k => !ignore.includes(k));
  const out: FieldChange[] = [];
  for (const key of keys) {
    if (Object.is(b[key], a[key])) continue;
    out.push({ field: key, before: b[key] ?? null, after: a[key] ?? null });
  }
  return out;
}
