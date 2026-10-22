import { describe, it, expect } from "vitest";
import { encode } from "gpt-tokenizer";
import { createRegistry } from "../../src/parsers/index.js";
import { toCompact } from "../../src/parsers/compact.js";
import { checkInvariants } from "../../src/parsers/invariants.js";

const raw = "00:00.0 Host bridge: Intel Corporation Xeon E7 v4/Xeon E5 v4/Xeon E3 v4/Xeon D DMI2 (rev 01)\n" +
  "00:01.0 PCI bridge: Intel Corporation Xeon E7 v4/Xeon E5 v4/Xeon E3 v4/Xeon D PCI Express Root Port 1 (rev 01)\n";
const devices = [
  { slot: "00:00.0", class: "Host bridge", description: "Intel Corporation Xeon E7 v4/Xeon E5 v4/Xeon E3 v4/Xeon D DMI2 (rev 01)" },
  { slot: "00:01.0", class: "PCI bridge", description: "Intel Corporation Xeon E7 v4/Xeon E5 v4/Xeon E3 v4/Xeon D PCI Express Root Port 1 (rev 01)" },
];
const registry = createRegistry();
const parse = (text: string, args: string[] = [], maxItems = 0) =>
  registry.parse("lspci", args, text, { maxItems, format: "json" }, true);

describe("lspci", () => {
  it("preserves PCI addresses, classes and complete device descriptions", () => {
    expect(parse(raw)).toEqual({ parsed: { devices } });
    expect(checkInvariants({ devices }, raw, registry.contractFor("lspci", []))).toEqual([]);
  });

  it.each([[], ["-D"]].map(args => [args]))("accepts domain-qualified addresses: %j", args => {
    expect(parse(" 0001:AF:1F.7\tClass 0880: Vendor Device abcd (rev ff)  \r\n", args)).toEqual({
      parsed: { devices: [{ slot: "0001:AF:1F.7", class: "Class 0880", description: "Vendor Device abcd (rev ff)" }] },
    });
  });

  it("preserves punctuation and accepts devices without revision information", () => {
    expect(parse("01:00.0 Ethernet controller: Vendor, Inc. Device: adapter [model]\n")).toEqual({
      parsed: { devices: [{ slot: "01:00.0", class: "Ethernet controller", description: "Vendor, Inc. Device: adapter [model]" }] },
    });
  });

  it.each(["", " \n\t", "\r\n"])("accepts empty output: %j", text => {
    expect(parse(text)).toEqual({ parsed: { devices: [] } });
  });

  it.each([
    "not lspci output", "00:00.0 Host bridge", "00:00.0 Host bridge: ", "00:00.0 : Vendor",
    "00:20.0 Host bridge: Vendor", "00:00.8 Host bridge: Vendor", "000:00.0 Host bridge: Vendor",
    "zz:00.0 Host bridge: Vendor", "00000:00:00.0 Host bridge: Vendor",
    raw + "broken row\n", raw + "\tKernel driver in use: pcieport\n",
  ])("rejects malformed output without partial results: %j", text => {
    expect(parse(text)).toMatchObject({ parsed: null, parse_error: { reason: "unrecognized_output" } });
  });

  it.each([["-v"], ["-vv"], ["-k"], ["-t"], ["-m"], ["-mm"], ["-n"], ["-nn"], ["-P"],
    ["--help"], ["--version"], ["device"]].map(args => [args]))(
    "rejects unsupported output formats and positional arguments: %j", args => {
      expect(parse(raw, args)).toMatchObject({ parsed: null, parse_error: { reason: "unsupported_format" } });
    },
  );

  it("limits rows with accurate counts and still validates omitted rows", () => {
    const result = parse(raw, [], 1);
    expect(result).toEqual({ parsed: {
      devices: devices.slice(0, 1), _summary: { total: 2, shown: 1, truncated: true },
    } });
    expect(checkInvariants(result.parsed, raw, registry.contractFor("lspci", []))).toEqual([]);
    expect(parse(raw + "broken\n", [], 1)).toMatchObject({
      parsed: null, parse_error: { reason: "unrecognized_output" },
    });
    expect(parse(raw, [], 2)).toEqual({ parsed: { devices } });
  });

  it("replays fixtures against the registered schema and row contract", () => {
    const pack = registry.getPack("lspci");
    expect(pack).toBeDefined();
    expect(pack!.fixtures.length).toBeGreaterThan(0);
    for (const fixture of pack!.fixtures) {
      expect(pack!.schema.safeParse(fixture.expected).success).toBe(true);
      expect(parse(fixture.input, fixture.args)).toEqual({ parsed: fixture.expected });
      expect(checkInvariants(fixture.expected, fixture.input, pack)).toEqual([]);
    }
  });

  it("preserves compact values and reduces tokens with compact and row limits", () => {
    const text = raw.repeat(20);
    const result = parse(text);
    expect(result.parse_error).toBeUndefined();
    const compact = toCompact(result.parsed);
    expect(compact.ok).toBe(true);
    if (!compact.ok) throw new Error(compact.message);
    const table = (compact.value as { devices: { schema: string[]; rows: unknown[][] } }).devices;
    expect(table.rows.map(row => Object.fromEntries(table.schema.map((key, i) => [key, row[i]]))))
      .toEqual(Array(20).fill(devices).flat());
    expect(encode(JSON.stringify(compact.value)).length).toBeLessThan(encode(JSON.stringify(result.parsed)).length);
    const limited = parse(text, [], 2);
    expect(limited).toEqual({ parsed: {
      devices, _summary: { total: 40, shown: 2, truncated: true },
    } });
    const limitedCompact = toCompact(limited.parsed);
    expect(limitedCompact.ok).toBe(true);
    if (!limitedCompact.ok) throw new Error(limitedCompact.message);
    expect(encode(JSON.stringify(limitedCompact.value)).length).toBeLessThan(encode(text).length);
  });
});
