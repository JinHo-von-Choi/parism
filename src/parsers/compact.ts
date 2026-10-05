export interface CompactArray {
  schema: string[];
  rows:   unknown[][];
}

/**
 * compact 표현 결과. 변환할 수 없으면 ok=false 를 돌려 호출자가 원형 JSON 으로 되돌리게 한다.
 * 이 함수는 절대 예외를 던지지 않는다(순환 값이나 BigInt 로 프로세스를 죽이지 않는다).
 */
export type CompactOutcome =
  | { ok: true;  value: unknown }
  | { ok: false; reason: "representation_not_lossless"; message: string };

/** 중첩 깊이 상한. 이보다 깊으면 원형 JSON 으로 되돌린다. */
const MAX_DEPTH = 64;

/**
 * 값을 손실 없이 직렬화할 수 없는 이유를 돌려준다. 없으면 null.
 * 순환 참조와 BigInt, 지나친 깊이를 찾는다. 같은 객체를 두 번 참조하는 것은 순환이 아니므로 허용한다.
 */
function notLosslessReason(value: unknown, seen: Set<object>, depth = 0): string | null {
  if (typeof value === "bigint") return "bigint value";
  if (value === null || typeof value !== "object") return null;
  if (depth > MAX_DEPTH) return `nesting deeper than ${MAX_DEPTH}`;
  if (seen.has(value)) return "circular reference";
  seen.add(value);
  try {
    const children = Array.isArray(value)
      ? value
      : Object.values(value as Record<string, unknown>);
    for (const child of children) {
      const reason = notLosslessReason(child, seen, depth + 1);
      if (reason) return reason;
    }
  } finally {
    seen.delete(value);
  }
  return null;
}

/** 행 배열을 항목이 모두 평범한 객체일 때만 compact 로 바꾼다. 섞여 있으면 원형을 그대로 둔다. */
function compactRows(value: unknown[]): { schema: string[]; rows: unknown[][] } | null {
  if (!value.every(item => typeof item === "object" && item !== null && !Array.isArray(item))) return null;
  const records = value as Record<string, unknown>[];
  /** 선택 필드가 뒤쪽 행에만 있어도 열이 빠지지 않도록 모든 행의 키를 처음 나온 순서로 모은다. */
  const schema = [...new Set(records.flatMap(item => Object.keys(item)))];
  /**
   * 중첩 배열과 객체는 그대로 둔다. 구분자 문자열로 이어 붙이면 값이 섞이고 복원이 불가능해진다.
   * 없는 키는 undefined 로 두고, 복원은 schema 와 같은 순서의 값을 다시 짝지으면 된다.
   */
  const rows = records.map(item => schema.map(key => item[key]));
  return { schema, rows };
}

/**
 * 파싱 결과를 컬럼 기반 compact 표로 바꾼다.
 * 값이 하나라도 보존되지 않으면(순환, BigInt, 과도한 깊이) 실패를 돌리고 원형 JSON 을 유지한다.
 * 값이 섞인 행 배열은 압축하지 않고 그대로 둔다(섞인 배열과 압축된 배열을 구분할 수 있어야 한다).
 */
export function toCompact(parsed: unknown): CompactOutcome {
  const bad = notLosslessReason(parsed, new Set());
  if (bad) {
    return { ok: false, reason: "representation_not_lossless", message: `compact conversion would lose data: ${bad}` };
  }
  if (parsed == null) return { ok: true, value: null };
  if (typeof parsed !== "object" || Array.isArray(parsed)) return { ok: true, value: parsed };

  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (!Array.isArray(value)) {
      result[key] = value;
      continue;
    }
    if (value.length === 0) {
      result[key] = { schema: [], rows: [] };
      continue;
    }
    result[key] = compactRows(value) ?? value;
  }
  return { ok: true, value: result };
}
