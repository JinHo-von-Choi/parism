import { describe, it, expect } from "vitest";
import { encode } from "gpt-tokenizer";
import { createRegistry } from "../../src/parsers/index.js";
import { toCompact } from "../../src/parsers/compact.js";
import { checkInvariants } from "../../src/parsers/invariants.js";

const raw = "Bus 001 Device 001: ID 1d6b:0002 Linux Foundation 2.0 root hub\n" +
  "Bus 004 Device 002: ID 0424:2660 Microchip Technology, Inc. (formerly SMSC) Hub\n";
const devices = [
  { bus: 1, device: 1, vendorId: "1d6b", productId: "0002", description: "Linux Foundation 2.0 root hub" },
  { bus: 4, device: 2, vendorId: "0424", productId: "2660", description: "Microchip Technology, Inc. (formerly SMSC) Hub" },
];
const registry = createRegistry();
const parse = (text: string, args: string[] = [], maxItems = 0) =>
  registry.parse("lsusb", args, text, { maxItems, format: "json" }, true);

describe("lsusb", () => {
  it("reads bus and device numbers, preserving hexadecimal IDs and descriptions", () => {
    expect(parse(raw)).toEqual({ parsed: { devices } });
    expect(checkInvariants({ devices }, raw, registry.contractFor("lsusb", []))).toEqual([]);
  });

  it.each(["", " \n\t", "\r\n"])("accepts empty output: %j", text => {
    expect(parse(text)).toEqual({ parsed: { devices: [] } });
  });

  it("accepts CRLF, variable whitespace and a device without a known description", () => {
    expect(parse(" Bus\t002 Device 003: ID ABCD:00EF  \r\n")).toEqual({
      parsed: { devices: [{ bus: 2, device: 3, vendorId: "ABCD", productId: "00EF", description: "" }] },
    });
  });

  it.each([
    "not lsusb output", "Bus 001 Device 001: ID 1d6b:000", "Bus 001 Device 001: ID xyz1:0002 hub",
    "Bus -01 Device 001: ID 1d6b:0002 hub", "Bus 001 Device NaN: ID 1d6b:0002 hub",
    "Bus 001 Device 001 ID 1d6b:0002 hub", "Bus 001 Device 001: ID 1d6b:00022 hub",
    raw + "broken row\n", raw + "  bDeviceClass 9 Hub\n",
  ])("rejects malformed output without partial success: %j", text => {
    expect(parse(text)).toMatchObject({ parsed: null, parse_error: { reason: "unrecognized_output" } });
  });

  it.each([["-v"], ["--verbose"], ["-t"], ["--tree"], ["-D", "/dev/bus/usb/001/001"],
    ["--help"], ["--version"], ["-s", "1:1"], ["-d", "1d6b:0002"], ["device"]].map(args => [args]))(
    "rejects arguments outside the default list format: %j", args => {
      expect(parse(raw, args)).toMatchObject({ parsed: null, parse_error: { reason: "unsupported_format" } });
    },
  );

  it("limits rows while validating all output and reporting the full count", () => {
    const result = parse(raw, [], 1);
    expect(result).toEqual({ parsed: {
      devices: devices.slice(0, 1), _summary: { total: 2, shown: 1, truncated: true },
    } });
    expect(checkInvariants(result.parsed, raw, registry.contractFor("lsusb", []))).toEqual([]);
    expect(parse(raw + "broken\n", [], 1)).toMatchObject({
      parsed: null, parse_error: { reason: "unrecognized_output" },
    });
    expect(parse(raw, [], 2)).toEqual({ parsed: { devices } });
  });

  it("replays registered fixtures against their schema and output contract", () => {
    const pack = registry.getPack("lsusb");
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
    expect(encode(JSON.stringify(compact.value)).length).toBeLessThan(encode(text).length);
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
