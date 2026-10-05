/**
 * 응답 투영과 필터(select, where, sort_by, limit) 단위 시험.
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 */

import { describe, it, expect } from "vitest";
import { PROJECTION_SCHEMA, applyProjection, hasProjection, type ProjectionOptions } from "../../src/engine/projection.js";
import { toCompact }                                                               from "../../src/parsers/compact.js";

const FIELDS = ["name", "type", "size_bytes", "target"] as const;

function sample(): { entries: Record<string, unknown>[] } {
  return {
    entries: [
      { name: "b.txt",   type: "file",      size_bytes: 30 },
      { name: "a.txt",   type: "file",      size_bytes: 10 },
      { name: "src",     type: "directory", size_bytes: 4096 },
      { name: "link",    type: "symlink",   size_bytes: 5, target: "a.txt" },
      { name: "c.txt",   type: "file",      size_bytes: 10 },
    ],
  };
}

function run(parsed: unknown, options: ProjectionOptions, rowsKey = "entries", rowFields: readonly string[] = FIELDS) {
  return applyProjection(parsed, options, { rowsKey, rowFields }, 0);
}

function names(result: ReturnType<typeof run>): unknown[] {
  if (!result.ok) throw new Error(`${result.reason}: ${result.message}`);
  return result.rows.map(r => (r as Record<string, unknown>).name);
}

describe("PROJECTION_SCHEMA", () => {
  it("문서화된 문법을 받는다", () => {
    const parsed = PROJECTION_SCHEMA.safeParse({
      select:  ["name", "size_bytes"],
      where:   [
        { field: "type", op: "eq", value: "file" },
        { field: "name", op: "prefix", value: "a" },
        { field: "name", op: "contains", value: "." },
        { field: "size_bytes", op: "gte", value: 10 },
        { field: "target", op: "eq", value: null },
      ],
      sort_by: { field: "size_bytes", order: "desc" },
      limit:   0,
      array:   "entries",
    });
    expect(parsed.success).toBe(true);
  });

  it.each([
    ["알 수 없는 연산자",           { where: [{ field: "name", op: "regex", value: "a" }] }],
    ["조건의 추가 키",             { where: [{ field: "name", op: "eq", value: "a", case: "i" }] }],
    ["prefix의 수 값",             { where: [{ field: "name", op: "prefix", value: 1 }] }],
    ["gt의 문자열 값",             { where: [{ field: "size_bytes", op: "gt", value: "10" }] }],
    ["무한대 비교 값",             { where: [{ field: "size_bytes", op: "lt", value: Infinity }] }],
    ["빈 필드 이름",               { select: [""] }],
    ["빈 select",                 { select: [] }],
    ["빈 where",                  { where: [] }],
    ["음수 limit",                { limit: -1 }],
    ["소수 limit",                { limit: 1.5 }],
    ["알 수 없는 정렬 방향",        { sort_by: { field: "name", order: "up" } }],
    ["정렬의 추가 키",             { sort_by: { field: "name", nulls: "first" } }],
    ["알 수 없는 최상위 키",        { filter: [] }],
  ])("%s는 거부한다", (_label, input) => {
    expect(PROJECTION_SCHEMA.safeParse(input).success).toBe(false);
  });
});

describe("hasProjection()", () => {
  it("선택 인자가 하나라도 있으면 참이다", () => {
    expect(hasProjection({})).toBe(false);
    expect(hasProjection({ limit: 0 })).toBe(true);
    expect(hasProjection({ array: "entries" })).toBe(true);
  });
});

describe("applyProjection() 연산자", () => {
  it("eq와 ne는 같은 형의 값을 비교한다", () => {
    expect(names(run(sample(), { where: [{ field: "type", op: "eq", value: "file" }] }))).toEqual(["b.txt", "a.txt", "c.txt"]);
    expect(names(run(sample(), { where: [{ field: "type", op: "ne", value: "file" }] }))).toEqual(["src", "link"]);
    expect(names(run(sample(), { where: [{ field: "size_bytes", op: "eq", value: 10 }] }))).toEqual(["a.txt", "c.txt"]);
  });

  it("eq null은 값이 없는 행, ne null은 값이 있는 행이다", () => {
    expect(names(run(sample(), { where: [{ field: "target", op: "eq", value: null }] }))).toEqual(["b.txt", "a.txt", "src", "c.txt"]);
    expect(names(run(sample(), { where: [{ field: "target", op: "ne", value: null }] }))).toEqual(["link"]);
  });

  it("prefix와 contains는 대소문자를 구분하는 문자열 비교다", () => {
    expect(names(run(sample(), { where: [{ field: "name", op: "prefix", value: "s" }] }))).toEqual(["src"]);
    expect(names(run(sample(), { where: [{ field: "name", op: "prefix", value: "S" }] }))).toEqual([]);
    expect(names(run(sample(), { where: [{ field: "name", op: "contains", value: "in" }] }))).toEqual(["link"]);
  });

  it("gt, gte, lt, lte는 수 비교다", () => {
    expect(names(run(sample(), { where: [{ field: "size_bytes", op: "gt", value: 10 }] }))).toEqual(["b.txt", "src"]);
    expect(names(run(sample(), { where: [{ field: "size_bytes", op: "gte", value: 10 }] }))).toEqual(["b.txt", "a.txt", "src", "c.txt"]);
    expect(names(run(sample(), { where: [{ field: "size_bytes", op: "lt", value: 10 }] }))).toEqual(["link"]);
    expect(names(run(sample(), { where: [{ field: "size_bytes", op: "lte", value: 10 }] }))).toEqual(["a.txt", "link", "c.txt"]);
  });

  it("값이 없는 필드는 비교 연산에 맞지 않는다", () => {
    expect(names(run(sample(), { where: [{ field: "target", op: "prefix", value: "a" }] }))).toEqual(["link"]);
  });

  it("여러 조건은 모두 맞아야 한다", () => {
    const result = run(sample(), { where: [
      { field: "type", op: "eq", value: "file" },
      { field: "size_bytes", op: "lt", value: 20 },
    ] });
    expect(names(result)).toEqual(["a.txt", "c.txt"]);
  });
});

describe("applyProjection() 정렬", () => {
  it("수 필드를 오름차순과 내림차순으로 정렬한다", () => {
    expect(names(run(sample(), { sort_by: { field: "size_bytes" } }))).toEqual(["link", "a.txt", "c.txt", "b.txt", "src"]);
    expect(names(run(sample(), { sort_by: { field: "size_bytes", order: "desc" } }))).toEqual(["src", "b.txt", "a.txt", "c.txt", "link"]);
  });

  it("같은 값의 행은 두 방향 모두 원래 순서를 지킨다", () => {
    const asc  = names(run(sample(), { sort_by: { field: "type" } }));
    const desc = names(run(sample(), { sort_by: { field: "type", order: "desc" } }));
    expect(asc).toEqual(["src", "b.txt", "a.txt", "c.txt", "link"]);
    expect(desc).toEqual(["link", "b.txt", "a.txt", "c.txt", "src"]);
  });

  it("값이 없는 행은 방향과 관계없이 뒤에 둔다", () => {
    expect(names(run(sample(), { sort_by: { field: "target" } }))[0]).toBe("link");
    expect(names(run(sample(), { sort_by: { field: "target", order: "desc" } }))[0]).toBe("link");
  });

  it("문자열은 코드 단위 순서로 정렬한다", () => {
    expect(names(run(sample(), { sort_by: { field: "name" } }))).toEqual(["a.txt", "b.txt", "c.txt", "link", "src"]);
  });
});

describe("applyProjection() 연산 순서와 요약", () => {
  it("where, sort_by, limit, select 순서로 적용한다", () => {
    const result = run(sample(), {
      where:   [{ field: "type", op: "eq", value: "file" }],
      sort_by: { field: "size_bytes", order: "desc" },
      limit:   2,
      select:  ["name"],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.parsed).toEqual({ entries: [{ name: "b.txt" }, { name: "a.txt" }], _summary: { total: 5, matched: 3, shown: 2 } });
    expect(result.summary).toEqual({ total: 5, matched: 3, shown: 2 });
  });

  it("select는 지정한 순서로 필드를 남기고 없는 필드는 만들지 않는다", () => {
    const result = run(sample(), { select: ["target", "name"], limit: 4 });
    if (!result.ok) throw new Error(result.message);
    expect(result.rows[3]).toEqual({ target: "a.txt", name: "link" });
    expect(Object.keys(result.rows[3] as object)).toEqual(["target", "name"]);
    expect(result.rows[0]).toEqual({ name: "b.txt" });
  });

  it("맞는 행이 없으면 빈 배열과 0 요약을 돌려준다", () => {
    const result = run(sample(), { where: [{ field: "name", op: "eq", value: "none" }] });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.rows).toEqual([]);
    expect(result.summary).toEqual({ total: 5, matched: 0, shown: 0 });
  });

  it("빈 배열은 계약의 필드 목록으로 필드 이름을 검사한다", () => {
    expect(run({ entries: [] }, { select: ["name"] }).ok).toBe(true);
    const bad = run({ entries: [] }, { select: ["nope"] });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.reason).toBe("unknown_field");
  });

  it("limit 0은 행 없이 개수만 돌려준다", () => {
    const result = run(sample(), { limit: 0 });
    if (!result.ok) throw new Error(result.message);
    expect(result.summary).toEqual({ total: 5, matched: 5, shown: 0 });
  });

  it("상한(max_items)이 limit보다 작으면 상한까지만 보이고 truncated를 남긴다", () => {
    const result = applyProjection(sample(), { limit: 4 }, { rowsKey: "entries", rowFields: FIELDS }, 3);
    if (!result.ok) throw new Error(result.message);
    expect(result.summary).toEqual({ total: 5, matched: 5, shown: 3, truncated: true });
  });

  it("다른 최상위 필드와 입력 객체는 그대로 둔다", () => {
    const input  = { ...sample(), directory: "/x" };
    const before = JSON.stringify(input);
    const result = run(input, { limit: 1 });
    if (!result.ok) throw new Error(result.message);
    expect((result.parsed as Record<string, unknown>).directory).toBe("/x");
    expect(JSON.stringify(input)).toBe(before);
  });
});

describe("applyProjection() 거부", () => {
  it.each([
    ["select", { select: ["name", "sizes"] }],
    ["where",  { where: [{ field: "owner", op: "eq", value: "x" }] }],
    ["sort_by", { sort_by: { field: "mtime" } }],
  ] as const)("%s의 알 수 없는 필드는 unknown_field다", (_label, options) => {
    const result = run(sample(), options as ProjectionOptions);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("unknown_field");
    expect(result.message).toContain("name");
  });

  it("행에만 있는 필드도 알려진 필드다", () => {
    expect(run(sample(), { select: ["target"] }, "entries", []).ok).toBe(true);
  });

  it.each([
    ["prefix를 수 필드에",  { where: [{ field: "size_bytes", op: "prefix", value: "1" }] }],
    ["gt를 문자열 필드에",  { where: [{ field: "name", op: "gt", value: 1 }] }],
    ["eq의 형이 다름",      { where: [{ field: "size_bytes", op: "eq", value: "10" }] }],
  ] as const)("%s 쓰면 type_mismatch다", (_label, options) => {
    const result = run(sample(), options as ProjectionOptions);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("type_mismatch");
  });

  it("값의 형이 섞인 필드로 정렬하면 type_mismatch다", () => {
    const input  = { entries: [{ v: 1 }, { v: "a" }] };
    const result = applyProjection(input, { sort_by: { field: "v" } }, undefined, 0);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("type_mismatch");
  });

  it("객체가 아닌 행은 필드가 없다", () => {
    const result = applyProjection({ paths: ["/a", "/b"] }, { select: ["name"] }, { rowsKey: "paths" }, 0);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("unknown_field");
  });

  it("객체가 아닌 행에도 limit은 적용한다", () => {
    const result = applyProjection({ paths: ["/a", "/b"] }, { limit: 1 }, { rowsKey: "paths" }, 0);
    if (!result.ok) throw new Error(result.message);
    expect(result.parsed).toEqual({ paths: ["/a"], _summary: { total: 2, matched: 2, shown: 1 } });
  });
});

describe("applyProjection() 대상 배열", () => {
  const twoArrays = { modified: [{ path: "a" }], untracked: [{ path: "b" }, { path: "c" }] };

  it("계약의 rowsKey를 먼저 쓴다", () => {
    const result = applyProjection(twoArrays, { limit: 1 }, { rowsKey: "untracked" }, 0);
    if (!result.ok) throw new Error(result.message);
    expect(result.summary.total).toBe(2);
  });

  it("array 인자로 배열을 고른다", () => {
    const result = applyProjection(twoArrays, { array: "modified", limit: 5 }, { rowsKey: "untracked" }, 0);
    if (!result.ok) throw new Error(result.message);
    expect(result.summary.total).toBe(1);
  });

  it("배열이 하나뿐이면 그 배열이다", () => {
    const result = applyProjection({ count: 1, items: [{ a: 1 }] }, { select: ["a"] }, undefined, 0);
    expect(result.ok).toBe(true);
  });

  it("배열이 여럿이고 고르지 않았으면 array_ambiguous다", () => {
    const result = applyProjection(twoArrays, { limit: 1 }, undefined, 0);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("array_ambiguous");
    expect(result.message).toContain("modified");
  });

  it("없는 배열 이름이나 배열이 없는 결과는 array_not_found다", () => {
    const missing = applyProjection(twoArrays, { array: "staged" }, undefined, 0);
    const none    = applyProjection({ kernel: "Linux" }, { limit: 1 }, undefined, 0);
    expect(!missing.ok && missing.reason).toBe("array_not_found");
    expect(!none.ok && none.reason).toBe("array_not_found");
  });

  it("최상위 배열에도 적용한다", () => {
    const result = applyProjection([{ n: 2 }, { n: 1 }], { sort_by: { field: "n" } }, undefined, 0);
    if (!result.ok) throw new Error(result.message);
    expect(result.parsed).toEqual([{ n: 1 }, { n: 2 }]);
    expect(result.summary).toEqual({ total: 2, matched: 2, shown: 2 });
  });
});

describe("applyProjection() 결과 객체", () => {
  it("select는 __proto__라는 이름의 자기 속성도 일반 필드로 남기고 결과 행의 프로토타입은 바꾸지 않는다", () => {
    const rows   = JSON.parse('[{"name":"a","__proto__":{"extra":true}}]') as unknown[];
    const result = applyProjection(rows, { select: ["name", "__proto__"] }, undefined, 0);
    if (!result.ok) throw new Error(result.message);
    const row = result.rows[0] as Record<string, unknown>;
    expect(Object.hasOwn(row, "__proto__")).toBe(true);
    expect(row.extra).toBeUndefined();
    expect(JSON.stringify(row)).toBe('{"name":"a","__proto__":{"extra":true}}');
  });

  it("대상이 아닌 배열도 max_items로 자르고 잘린 배열 이름을 요약에 남긴다", () => {
    const many   = (n: number) => Array.from({ length: n }, (_, i) => ({ i }));
    const parsed = { entries: many(5), errors: many(4), tags: many(2), label: "x" };
    const result = applyProjection(parsed, { array: "errors", limit: 1 }, undefined, 3);
    if (!result.ok) throw new Error(result.message);
    const out = result.parsed as { entries: unknown[]; errors: unknown[]; tags: unknown[]; label: string };
    expect(out.entries).toHaveLength(3);
    expect(out.errors).toHaveLength(1);
    expect(out.tags).toHaveLength(2);
    expect(out.label).toBe("x");
    expect(result.summary).toEqual({ total: 4, matched: 4, shown: 1, truncated_arrays: ["entries"] });
  });

  it("max_items가 0이면 대상이 아닌 배열을 자르지 않는다", () => {
    const parsed = { entries: [{ a: 1 }, { a: 2 }], errors: [{ e: 1 }] };
    const result = applyProjection(parsed, { array: "errors" }, undefined, 0);
    if (!result.ok) throw new Error(result.message);
    expect((result.parsed as { entries: unknown[] }).entries).toHaveLength(2);
    expect(result.summary).toEqual({ total: 1, matched: 1, shown: 1 });
  });
});

describe("applyProjection()과 compact", () => {
  it("compact 열은 select 순서다", () => {
    const result = run(sample(), { select: ["size_bytes", "name"], sort_by: { field: "name" }, limit: 2 });
    if (!result.ok) throw new Error(result.message);
    const compact = toCompact(result.parsed);
    if (!compact.ok) throw new Error(compact.message);
    expect(compact.value).toEqual({
      entries:  { schema: ["size_bytes", "name"], rows: [[10, "a.txt"], [30, "b.txt"]] },
      _summary: { total: 5, matched: 5, shown: 2 },
    });
  });
});
