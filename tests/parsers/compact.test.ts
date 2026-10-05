import { describe, it, expect } from "vitest";
import { toCompact, type CompactOutcome } from "../../src/parsers/compact.js";

/** 성공한 변환의 값. 실패면 테스트가 원인을 보여 준다. */
function value(outcome: CompactOutcome): unknown {
  if (!outcome.ok) throw new Error(`expected lossless conversion, got: ${outcome.message}`);
  return outcome.value;
}

describe("toCompact()", () => {
  it("객체 배열을 schema + rows로 변환한다", () => {
    const input = {
      entries: [
        { name: "src", type: "directory", size_bytes: 4096 },
        { name: "main.ts", type: "file", size_bytes: 1200 },
      ],
    };
    expect(value(toCompact(input))).toEqual({
      entries: {
        schema: ["name", "type", "size_bytes"],
        rows: [["src", "directory", 4096], ["main.ts", "file", 1200]],
      },
    });
  });

  it("빈 배열은 schema=[], rows=[]로 변환한다", () => {
    expect(value(toCompact({ entries: [] }))).toEqual({ entries: { schema: [], rows: [] } });
  });

  it("배열이 아닌 필드는 그대로 유지한다", () => {
    const input = { path: "/home/user", entries: [{ name: "a" }] };
    expect(value(toCompact(input))).toEqual({
      path: "/home/user",
      entries: { schema: ["name"], rows: [["a"]] },
    });
  });

  it("중첩 객체가 아닌 배열(문자열 배열 등)은 그대로 유지한다", () => {
    expect(value(toCompact({ paths: ["/a", "/b", "/c"] }))).toEqual({ paths: ["/a", "/b", "/c"] });
  });

  it("_summary 필드는 그대로 유지한다", () => {
    const input = {
      entries: [{ name: "a", type: "file" }],
      _summary: { total: 100, shown: 1, truncated: true },
    };
    const out = value(toCompact(input)) as Record<string, unknown>;
    expect(out._summary).toEqual({ total: 100, shown: 1, truncated: true });
    expect(out.entries).toEqual({ schema: ["name", "type"], rows: [["a", "file"]] });
  });

  it("null 입력은 null을 반환한다", () => {
    expect(value(toCompact(null))).toBeNull();
  });

  it("뒤쪽 행에만 있는 선택 필드도 열로 남긴다", () => {
    const out = value(toCompact({ rows: [{ name: "a" }, { name: "b", flag: true }] })) as {
      rows: { schema: string[]; rows: unknown[][] };
    };
    expect(out.rows).toEqual({ schema: ["name", "flag"], rows: [["a", undefined], ["b", true]] });
  });
});

describe("toCompact() 값 보존", () => {
  it("중첩 배열을 구분자 문자열로 평탄화하지 않고 그대로 둔다", () => {
    const input = {
      items: [
        { name: "a", tags: ["x", "y"], args: ["-v", "--help"] },
        { name: "b", tags: ["z"], args: [] },
      ],
    };
    expect(value(toCompact(input))).toEqual({
      items: {
        schema: ["name", "tags", "args"],
        rows:  [["a", ["x", "y"], ["-v", "--help"]], ["b", ["z"], []]],
      },
    });
  });

  it("구분자 문자를 값이 품은 배열과 구분할 수 있다", () => {
    /** 이전 구현은 ["a|b","c"] 와 ["a","b","c"] 를 모두 "a|b|c" 로 만들었다. */
    const input  = { items: [{ v: ["a|b", "c"] }] };
    const out    = value(toCompact(input)) as { items: { schema: string[]; rows: unknown[][] } };
    expect(out.items.rows[0]![0]).toEqual(["a|b", "c"]);
  });

  it("중첩 객체를 JSON 문자열로 바꾸지 않고 그대로 둔다", () => {
    expect(value(toCompact({ items: [{ id: 1, meta: { a: 1, b: 2 } }] }))).toEqual({
      items: { schema: ["id", "meta"], rows: [[1, { a: 1, b: 2 }]] },
    });
  });

  it("배열 안의 null 과 객체를 원래 값으로 둔다", () => {
    const input = { items: [{ id: 1, tags: ["p", null, { k: 1 }] }] };
    expect(value(toCompact(input))).toEqual({
      items: { schema: ["id", "tags"], rows: [[1, ["p", null, { k: 1 }]]] },
    });
  });

  it("값이 섞인 행 배열은 압축하지 않고 그대로 둔다", () => {
    /** 49개 객체 뒤에 null 이 오는 배열은 이전 구현에서 TypeError 로 죽었다. */
    const mixed = [...Array.from({ length: 49 }, (_, i) => ({ a: i })), null];
    expect(value(toCompact({ entries: mixed }))).toEqual({ entries: mixed });
  });

  it("첫 행이 객체가 아니어도 나머지 행을 잃지 않는다", () => {
    expect(value(toCompact({ entries: [{ a: 1 }, "str"] }))).toEqual({ entries: [{ a: 1 }, "str"] });
  });

  it("Unicode 값을 그대로 둔다", () => {
    const input = { entries: [{ name: "파일-이름", note: "café \u{1F600}" }] };
    expect(value(toCompact(input))).toEqual({
      entries: { schema: ["name", "note"], rows: [["파일-이름", "café \u{1F600}"]] },
    });
  });

  it("200행 중첩 JSON 도 값이 보존된다", () => {
    const input = {
      entries: Array.from({ length: 200 }, (_, i) => ({
        id: i, meta: { nested: { deep: i } }, tags: [`t${i}`],
      })),
    };
    const out = value(toCompact(input)) as { entries: { schema: string[]; rows: unknown[][] } };
    expect(out.entries.schema).toEqual(["id", "meta", "tags"]);
    expect(out.entries.rows).toHaveLength(200);
    expect(out.entries.rows[199]).toEqual([199, { nested: { deep: 199 } }, ["t199"]]);
  });

  it("복원하면 원래 값과 같다 (decode(encode(x)) = x)", () => {
    const input = {
      entries: [
        { name: "a", meta: { x: 1 }, tags: ["p|q", "r"] },
        { name: "b", meta: null, tags: [] },
      ],
    };
    const out = value(toCompact(input)) as { entries: { schema: string[]; rows: unknown[][] } };
    const decoded = out.entries.rows.map(row =>
      Object.fromEntries(out.entries.schema.map((k, i) => [k, row[i]])),
    );
    expect(decoded).toEqual(input.entries);
  });
});

describe("toCompact() 실패는 프로세스 예외가 아니라 결과다", () => {
  it("순환 참조를 실패로 보고한다", () => {
    const circular: Record<string, unknown> = { a: 1 };
    circular.self = circular;
    const out = toCompact({ entries: [{ o: circular }] });
    expect(out.ok).toBe(false);
    expect(out.ok === false && out.reason).toBe("representation_not_lossless");
    expect(out.ok === false && out.message).toMatch(/circular/);
  });

  it("BigInt 를 실패로 보고한다", () => {
    const out = toCompact({ entries: [{ a: 1n }] });
    expect(out.ok).toBe(false);
    expect(out.ok === false && out.message).toMatch(/bigint/);
  });

  it("과도한 중첩을 실패로 보고한다", () => {
    let deep: unknown = "leaf";
    for (let i = 0; i < 80; i++) deep = { next: deep };
    expect(toCompact({ entries: [{ deep }] }).ok).toBe(false);
  });

  it("같은 객체를 두 번 참조하는 것은 순환이 아니다", () => {
    const shared = { a: 1 };
    expect(toCompact({ entries: [{ x: shared }, { y: shared }] }).ok).toBe(true);
  });
});
