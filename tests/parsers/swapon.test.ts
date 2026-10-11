import { describe, it, expect } from "vitest";
import { encode } from "gpt-tokenizer";
import { createRegistry } from "../../src/parsers/index.js";
import { checkInvariants } from "../../src/parsers/invariants.js";
import { toCompact } from "../../src/parsers/compact.js";

const header = "NAME          TYPE       SIZE  USED PRIO";
const raw = `${header}\n/swap.img     file        32G 13.1G   -2\n/dev/zram0    partition    8G    0B  100\n`;
const swaps = [
  { name: "/swap.img", type: "file", size: "32G", used: "13.1G", priority: -2 },
  { name: "/dev/zram0", type: "partition", size: "8G", used: "0B", priority: 100 },
];
const registry = createRegistry();
const parse = (text: string, args = ["--show"], maxItems = 0) =>
  registry.parse("swapon", args, text, { maxItems, format: "json" }, true);

describe("swapon --show", () => {
  it("reads human-readable sizes without losing units or signed priorities", () => {
    expect(parse(raw)).toEqual({ parsed: { swaps } });
    expect(checkInvariants({ swaps }, raw, registry.contractFor("swapon", ["--show"]))).toEqual([]);
  });

  it.each(["", " \n\t", `${header}\n`])("accepts empty output: %j", text => {
    expect(parse(text)).toEqual({ parsed: { swaps: [] } });
  });

  it("handles CRLF, whitespace in file names and byte-sized values", () => {
    expect(parse(`${header}\r\n /swap file\tfile\t512B\t0B\t0 \r\n`)).toEqual({
      parsed: { swaps: [{ name: "/swap file", type: "file", size: "512B", used: "0B", priority: 0 }] },
    });
  });

  it.each([
    "not swapon output", "NAME TYPE SIZE USED", raw.replace(header, "Filename Type Size Used Priority"),
    raw.replace("32G", "NaN"), raw.replace("32G", "-1G"), raw.replace("32G", "32"),
    raw.replace("13.1G", "13.1GB"), raw.replace("file", "unknown"),
    raw.replace("-2", "1.5"), raw.replace("-2", "9007199254740992"),
    raw + "broken row\n", raw + header,
  ])("rejects malformed output without partial success: %j", text => {
    expect(parse(text)).toMatchObject({ parsed: null, parse_error: { reason: "unrecognized_output" } });
  });

  it.each([[], ["--summary"], ["--show=NAME"], ["--show", "--bytes"],
    ["--show", "--noheadings"], ["--show", "--raw"], ["--show", "--all"],
    ["--show", "/swap.img"]].map(args => [args]))("rejects other formats or activation arguments: %j", args => {
    expect(parse(raw, args).parse_error?.reason).toBe("unsupported_format");
  });

  it("limits rows while validating omitted rows and reporting the full count", () => {
    const result = parse(raw, ["--show"], 1);
    expect(result).toEqual({ parsed: {
      swaps: swaps.slice(0, 1), _summary: { total: 2, shown: 1, truncated: true },
    } });
    expect(checkInvariants(result.parsed, raw, registry.contractFor("swapon", ["--show"]))).toEqual([]);
    expect(parse(raw + "broken\n", ["--show"], 1).parse_error?.reason).toBe("unrecognized_output");
    expect(parse(raw, ["--show"], 2)).toEqual({ parsed: { swaps } });
  });

  it("replays pack fixtures against the schema and contract", () => {
    const pack = registry.getPack("swapon");
    expect(pack).toBeDefined();
    expect(pack!.fixtures.length).toBeGreaterThan(0);
    for (const fixture of pack!.fixtures) {
      expect(pack!.schema.safeParse(fixture.expected).success).toBe(true);
      expect(parse(fixture.input, fixture.args)).toEqual({ parsed: fixture.expected });
      expect(checkInvariants(fixture.expected, fixture.input, pack)).toEqual([]);
    }
  });

  it("preserves compact values and reduces tokens with row limits", () => {
    const text = `${header}\n${Array(20).fill(raw.split("\n").slice(1, -1).join("\n")).join("\n")}\n`;
    const result = parse(text);
    const compact = toCompact(result.parsed);
    expect(compact.ok).toBe(true);
    if (!compact.ok) throw new Error(compact.message);
    const table = (compact.value as { swaps: { schema: string[]; rows: unknown[][] } }).swaps;
    expect(table.rows.map(row => Object.fromEntries(table.schema.map((key, i) => [key, row[i]]))))
      .toEqual(Array(20).fill(swaps).flat());
    expect(encode(JSON.stringify(compact.value)).length).toBeLessThan(encode(JSON.stringify(result.parsed)).length);
    const limited = parse(text, ["--show"], 2);
    expect(limited).toEqual({ parsed: {
      swaps, _summary: { total: 40, shown: 2, truncated: true },
    } });
    const limitedCompact = toCompact(limited.parsed);
    expect(limitedCompact.ok).toBe(true);
    if (!limitedCompact.ok) throw new Error(limitedCompact.message);
    expect(encode(JSON.stringify(limitedCompact.value)).length).toBeLessThan(encode(text).length);
  });
});
