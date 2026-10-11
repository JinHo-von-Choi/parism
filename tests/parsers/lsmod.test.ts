import { describe, it, expect } from "vitest";
import { encode } from "gpt-tokenizer";
import { createRegistry } from "../../src/parsers/index.js";
import { toCompact } from "../../src/parsers/compact.js";
import { checkInvariants } from "../../src/parsers/invariants.js";

const header = "Module                  Size  Used by";
const raw = `${header}\nusb_storage            90112  2\nhid                   180224  2 usbhid,hid_generic\ncryptd                 24576  2 crypto_simd,ghash_clmulni_intel\n`;
const modules = [
  { name: "usb_storage", size: 90112, used: 2, usedBy: [] },
  { name: "hid", size: 180224, used: 2, usedBy: ["usbhid", "hid_generic"] },
  { name: "cryptd", size: 24576, used: 2, usedBy: ["crypto_simd", "ghash_clmulni_intel"] },
];
const registry = createRegistry();
const parse = (text: string, args: string[] = [], maxItems = 0) =>
  registry.parse("lsmod", args, text, { maxItems, format: "json" }, true);

describe("lsmod", () => {
  it("reads module sizes in bytes, usage counts and dependent modules", () => {
    expect(parse(raw)).toEqual({ parsed: { modules } });
    expect(checkInvariants({ modules }, raw, registry.contractFor("lsmod", []))).toEqual([]);
  });

  it.each(["", " \n\t", `${header}\n`])("accepts empty output: %j", text => {
    expect(parse(text)).toEqual({ parsed: { modules: [] } });
  });

  it("handles CRLF, variable whitespace and zero values", () => {
    expect(parse(` ${header}\r\n module_1\t0\t0  \r\n`)).toEqual({
      parsed: { modules: [{ name: "module_1", size: 0, used: 0, usedBy: [] }] },
    });
  });

  it.each([
    "not lsmod output", "hid 180224 2 usbhid,hid_generic", "Module Size Used", `${header}\nbroken`,
    raw + "broken row\n", raw + header, raw.replace("180224", "NaN"),
    raw.replace("180224", "-1"), raw.replace("180224", "1.5"),
    raw.replace("180224", "9007199254740992"), raw.replace("2 usbhid", "-1 usbhid"),
    raw.replace("2 usbhid", "9007199254740992 usbhid"),
    raw.replace("usbhid,hid_generic", "usbhid,,hid_generic"),
    raw.replace("usbhid,hid_generic", "usbhid hid_generic"),
  ])("rejects malformed output without partial success: %j", text => {
    expect(parse(text).parse_error?.reason).toBe("unrecognized_output");
  });

  it.each([["--help"], ["--version"], ["-h"], ["hid"]].map(args => [args]))(
    "rejects arguments outside the default table format: %j", args => {
      expect(parse(raw, args).parse_error?.reason).toBe("unsupported_format");
    },
  );

  it("limits rows while validating all output and reporting the full count", () => {
    const result = parse(raw, [], 1);
    expect(result).toEqual({ parsed: {
      modules: modules.slice(0, 1), _summary: { total: 3, shown: 1, truncated: true },
    } });
    expect(checkInvariants(result.parsed, raw, registry.contractFor("lsmod", []))).toEqual([]);
    expect(parse(raw + "broken\n", [], 1).parse_error?.reason).toBe("unrecognized_output");
    expect(parse(raw, [], 3)).toEqual({ parsed: { modules } });
  });

  it("replays registered fixtures against their schema and output contract", () => {
    const pack = registry.getPack("lsmod");
    expect(pack).toBeDefined();
    expect(pack!.fixtures.length).toBeGreaterThan(0);
    for (const fixture of pack!.fixtures) {
      expect(pack!.schema.safeParse(fixture.expected).success).toBe(true);
      expect(parse(fixture.input, fixture.args)).toEqual({ parsed: fixture.expected });
      expect(checkInvariants(fixture.expected, fixture.input, pack)).toEqual([]);
    }
  });

  it("preserves compact values and reduces tokens with compact and row limits", () => {
    const text = `${header}\n${Array(20).fill(raw.split("\n").slice(1, -1).join("\n")).join("\n")}\n`;
    const result = parse(text);
    expect(result.parse_error).toBeUndefined();
    const compact = toCompact(result.parsed);
    expect(compact.ok).toBe(true);
    if (!compact.ok) throw new Error(compact.message);
    const table = (compact.value as { modules: { schema: string[]; rows: unknown[][] } }).modules;
    expect(table.rows.map(row => Object.fromEntries(table.schema.map((key, i) => [key, row[i]]))))
      .toEqual(Array(20).fill(modules).flat());
    expect(encode(JSON.stringify(compact.value)).length).toBeLessThan(encode(JSON.stringify(result.parsed)).length);
    const limited = parse(text, [], 3);
    expect(limited).toEqual({ parsed: {
      modules, _summary: { total: 60, shown: 3, truncated: true },
    } });
    const limitedCompact = toCompact(limited.parsed);
    expect(limitedCompact.ok).toBe(true);
    if (!limitedCompact.ok) throw new Error(limitedCompact.message);
    expect(encode(JSON.stringify(limitedCompact.value)).length).toBeLessThan(encode(text).length);
  });
});
