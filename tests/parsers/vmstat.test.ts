import { describe, it, expect } from "vitest";
import { encode } from "gpt-tokenizer";
import { createRegistry } from "../../src/parsers/index.js";
import { toCompact } from "../../src/parsers/compact.js";
import { checkInvariants } from "../../src/parsers/invariants.js";

const group = "procs -----------memory---------- ---swap-- -----io---- -system-- -------cpu-------";
const columns = " r  b   swpd   free   buff  cache   si   so    bi    bo   in   cs us sy id wa st";
const row = " 7  0 13828748 12804456 3476588 65059760    6   27   538  4850 16692    3  7  1 92  0  0";
const raw = `${group}\n${columns} gu\n${row}  0\n`;
const expected = { r: 7, b: 0, swpd: 13828748, free: 12804456, buff: 3476588, cache: 65059760,
  si: 6, so: 27, bi: 538, bo: 4850, in: 16692, cs: 3, us: 7, sy: 1, id: 92, wa: 0, st: 0, gu: 0 };
const registry = createRegistry();
const parse = (text: string, args: string[] = [], maxItems = 0) =>
  registry.parse("vmstat", args, text, { maxItems, format: "json" }, true);

describe("vmstat", () => {
  it("실제 Linux 출력과 guest 열을 스키마에 맞게 읽는다", () => {
    expect(parse(raw)).toEqual({ parsed: { unit: "KiB", samples: [expected] } });
  });

  it("guest 열이 없는 기존 형식과 반복 머리 줄을 보존한다", () => {
    const text = `${group}\n${columns}\n${row}\n${group}\n${columns}\n${row}\n`;
    const legacy = Object.fromEntries(Object.entries(expected).filter(([key]) => key !== "gu"));
    const result = parse(text, ["1", "2"]);
    expect(result).toEqual({ parsed: { unit: "KiB", samples: [legacy, legacy] } });
    expect(checkInvariants(result.parsed, text, registry.contractFor("vmstat", ["1", "2"]))).toEqual([]);
  });

  it.each(["", " \n\t", `${group}\n${columns}\n`])("빈 결과를 정상 처리한다: %j", text => {
    expect(parse(text)).toEqual({ parsed: { unit: "KiB", samples: [] } });
  });

  it.each([
    "not vmstat output", row, group, `${group}\n${group}`,
    raw + `${group}\n${columns}\n${row}\n`, `${group}\ninvalid columns\n${row}`,
    `${group}\n${columns}\n${row} 1`, raw + "broken row\n",
    raw.replace("13828748", "NaN"), raw.replace("13828748", "-1"),
    raw.replace("13828748", "9007199254740992"), raw.replace("13828748", "1.5"),
  ])("손상된 출력을 부분 성공으로 숨기지 않는다: %j", text => {
    expect(parse(text).parse_error?.reason).toBe("unrecognized_output");
  });

  it.each([["-s"], ["-d"], ["-a"], ["-t"], ["-S", "M"], ["--help"], ["x"], ["1", "2", "3"]].map(args => [args]))(
    "지원 범위 밖 인자를 거부한다: %j", args => {
      expect(parse(raw, args).parse_error?.reason).toBe("unsupported_format");
    },
  );

  it("CRLF와 값이 모두 0인 행도 읽는다", () => {
    const text = `${group}\r\n${columns}\r\n${Array(17).fill("0").join(" ")}\r\n`;
    const samples = [Object.fromEntries(Object.keys(expected).filter(key => key !== "gu").map(key => [key, 0]))];
    expect(parse(text)).toEqual({ parsed: { unit: "KiB", samples } });
  });

  it("행 제한을 적용하면서 전체 수와 잘린 뒤의 손상도 확인한다", () => {
    const text = `${group}\n${columns} gu\n${row} 0\n${row} 0\n`;
    expect(parse(text, ["-n", "1", "2"], 1)).toEqual({ parsed: {
      unit: "KiB", samples: [expected], _summary: { total: 2, shown: 1, truncated: true },
    } });
    expect(parse(text + "broken\n", [], 1).parse_error?.reason).toBe("unrecognized_output");
  });

  it("등록한 fixture를 스키마와 불변식으로 검증한다", () => {
    const pack = registry.getPack("vmstat");
    expect(pack).toBeDefined();
    expect(pack!.fixtures.length).toBeGreaterThan(0);
    for (const fixture of pack!.fixtures) {
      expect(pack!.schema.safeParse(fixture.expected).success).toBe(true);
      const result = parse(fixture.input, fixture.args);
      expect(result).toEqual({ parsed: fixture.expected });
      expect(checkInvariants(result.parsed, fixture.input, pack)).toEqual([]);
    }
  });

  it("compact가 값을 보존하면서 반복 표의 토큰을 줄인다", () => {
    const text = `${group}\n${columns} gu\n${Array(20).fill(`${row} 0`).join("\n")}\n`;
    const result = parse(text, ["--one-header", "1", "20"]);
    expect(result.parse_error).toBeUndefined();
    const compact = toCompact(result.parsed);
    expect(compact.ok).toBe(true);
    if (!compact.ok) throw new Error(compact.message);
    const samples = (compact.value as { samples: { schema: string[]; rows: number[][] } }).samples;
    expect(samples.rows.map(values => Object.fromEntries(samples.schema.map((key, i) => [key, values[i]]))))
      .toEqual(Array(20).fill(expected));
    expect(encode(JSON.stringify(compact.value)).length).toBeLessThan(encode(text).length);
    expect(encode(JSON.stringify(compact.value)).length).toBeLessThan(encode(JSON.stringify(result.parsed)).length);
  });
});
