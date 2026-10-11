import { describe, it, expect } from "vitest";
import { encode } from "gpt-tokenizer";
import { createRegistry } from "../../src/parsers/index.js";
import { toCompact } from "../../src/parsers/compact.js";
import { checkInvariants } from "../../src/parsers/invariants.js";

const args = ["-brief", "link"];
const raw = "lo               UNKNOWN        00:00:00:00:00:00 <LOOPBACK,UP,LOWER_UP>\n" +
  "eth0@if2         UP             02:00:00:00:00:01 <BROADCAST,MULTICAST,UP,LOWER_UP>\n" +
  "tun0             DOWN           <POINTOPOINT,NOARP>\n";
const interfaces = [
  { name: "lo", state: "UNKNOWN", address: "00:00:00:00:00:00", flags: ["LOOPBACK", "UP", "LOWER_UP"] },
  { name: "eth0@if2", state: "UP", address: "02:00:00:00:00:01", flags: ["BROADCAST", "MULTICAST", "UP", "LOWER_UP"] },
  { name: "tun0", state: "DOWN", address: null, flags: ["POINTOPOINT", "NOARP"] },
];
const registry = createRegistry();
const parse = (text: string, argv = args, maxItems = 0) =>
  registry.parse("ip", argv, text, { maxItems, format: "json" }, true);

describe("ip brief link", () => {
  it("preserves interface names, states, link addresses and flags", () => {
    expect(parse(raw)).toEqual({ parsed: { interfaces } });
    expect(checkInvariants({ interfaces }, raw, registry.contractFor("ip", args))).toEqual([]);
  });

  it.each(["", " \n\t"])("accepts empty output: %j", text => {
    expect(parse(text)).toEqual({ parsed: { interfaces: [] } });
  });

  it.each([["-br", "link"], ["-brief", "link", "show"], ["-br", "link", "show"]])(
    "accepts the brief alias and explicit show: %j", (...argv) => {
      expect(parse(raw.replaceAll("\n", "\r\n"), argv)).toEqual({ parsed: { interfaces } });
    },
  );

  it("handles tabs, empty flags and non-Ethernet addresses", () => {
    const address = Array(20).fill("ab").join(":");
    expect(parse(` ib0\tDORMANT\t${address}\t<> \n`)).toEqual({ parsed: {
      interfaces: [{ name: "ib0", state: "DORMANT", address, flags: [] }],
    } });
  });

  it.each(["0.0.0.0", "2001:db8::1", "02:00:00:00:00:00:00:01"])(
    "preserves tunnel and extended link addresses: %s", address => {
      expect(parse(`tunnel0 UNKNOWN ${address} <NOARP>\n`)).toEqual({ parsed: {
        interfaces: [{ name: "tunnel0", state: "UNKNOWN", address, flags: ["NOARP"] }],
      } });
    },
  );

  it.each([
    "not ip output", "lo UNKNOWN", "lo UNKNOWN <UP> extra", "lo INVALID <UP>",
    "lo UP invalid <UP>", "lo UP 02:00:00 <UP>", "lo UP 999.0.0.0 <UP>", "lo UP <UP,,LOWER_UP>",
    "lo UP <UP LOWER_UP>", "lo UP <up>", raw + "broken row\n",
  ])("rejects malformed output without partial success: %j", text => {
    expect(parse(text)).toMatchObject({ parsed: null, parse_error: { reason: "unrecognized_output" } });
  });

  it.each([
    [], ["link"], ["-brief", "address"], ["-json", "link"], ["-brief", "link", "set"],
    ["-brief", "link", "show", "eth0"], ["-brief", "-details", "link"], ["-brief", "link", "--help"],
  ])("rejects unverified output formats: %j", (...argv) => {
    expect(parse(raw, argv).parse_error?.reason).toBe("unsupported_format");
  });

  it("limits rows while validating the entire output", () => {
    const result = parse(raw, args, 1);
    expect(result).toEqual({ parsed: {
      interfaces: interfaces.slice(0, 1), _summary: { total: 3, shown: 1, truncated: true },
    } });
    expect(checkInvariants(result.parsed, raw, registry.contractFor("ip", args))).toEqual([]);
    expect(parse(raw + "broken\n", args, 1).parse_error?.reason).toBe("unrecognized_output");
    expect(parse(raw, args, 3)).toEqual({ parsed: { interfaces } });
  });

  it("replays registered fixtures against their schema and contract", () => {
    const pack = registry.getPack("ip");
    expect(pack).toBeDefined();
    expect(pack!.fixtures.length).toBeGreaterThan(0);
    for (const fixture of pack!.fixtures) {
      expect(pack!.schema.safeParse(fixture.expected).success).toBe(true);
      expect(parse(fixture.input, fixture.args)).toEqual({ parsed: fixture.expected });
      expect(checkInvariants(fixture.expected, fixture.input, pack)).toEqual([]);
    }
  });

  it("preserves compact values and reduces tokens with row limits", () => {
    const text = raw.repeat(20);
    const result = parse(text);
    const compact = toCompact(result.parsed);
    expect(compact.ok).toBe(true);
    if (!compact.ok) throw new Error(compact.message);
    const table = (compact.value as { interfaces: { schema: string[]; rows: unknown[][] } }).interfaces;
    expect(table.rows.map(row => Object.fromEntries(table.schema.map((key, i) => [key, row[i]]))))
      .toEqual(Array(20).fill(interfaces).flat());
    expect(encode(JSON.stringify(compact.value)).length).toBeLessThan(encode(JSON.stringify(result.parsed)).length);
    const limited = parse(text, args, 3);
    expect(limited).toEqual({ parsed: {
      interfaces, _summary: { total: 60, shown: 3, truncated: true },
    } });
    const limitedCompact = toCompact(limited.parsed);
    expect(limitedCompact.ok).toBe(true);
    if (!limitedCompact.ok) throw new Error(limitedCompact.message);
    expect(encode(JSON.stringify(limitedCompact.value)).length).toBeLessThan(encode(text).length);
  });
});
