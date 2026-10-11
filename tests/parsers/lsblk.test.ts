import { describe, it, expect } from "vitest";
import { encode } from "gpt-tokenizer";
import { createRegistry } from "../../src/parsers/index.js";
import { checkInvariants } from "../../src/parsers/invariants.js";
import { toCompact } from "../../src/parsers/compact.js";

const args = ["-b", "-l", "-o", "NAME,SIZE,TYPE"];
const header = "NAME                   SIZE TYPE";
const raw = `${header}\nnvme0n1        512110190592 disk\nnvme0n1p1        1073741824 part\nzram0                    0 disk\n`;
const devices = [
  { name: "nvme0n1", size: 512110190592, type: "disk" },
  { name: "nvme0n1p1", size: 1073741824, type: "part" },
  { name: "zram0", size: 0, type: "disk" },
];
const registry = createRegistry();
const parse = (text: string, flags = args, maxItems = 0) =>
  registry.parse("lsblk", flags, text, { maxItems, format: "json" }, true);

describe("lsblk byte list", () => {
  it("reads device names, byte sizes and types without losing rows", () => {
    expect(registry.hasParser("lsblk")).toBe(true);
    expect(parse(raw)).toEqual({ parsed: { devices } });
    expect(checkInvariants({ devices }, raw, registry.contractFor("lsblk", args))).toEqual([]);
  });

  it.each(["", " \n\t", `${header}\n`])("accepts empty output: %j", text => {
    expect(parse(text)).toEqual({ parsed: { devices: [] } });
  });

  it("handles CRLF, tabs, mapper names and additional device types", () => {
    expect(parse("NAME SIZE TYPE\r\nvg-root\t4096\tlvm\r\nmd0 8192 raid1\r\nsr0 0 rom\r\n")).toEqual({
      parsed: { devices: [
        { name: "vg-root", size: 4096, type: "lvm" },
        { name: "md0", size: 8192, type: "raid1" },
        { name: "sr0", size: 0, type: "rom" },
      ] },
    });
  });

  it.each([
    "unrelated output", "nvme0n1 4096 disk", "NAME TYPE SIZE\nnvme0n1 disk 4096",
    raw + "broken\n", raw + header, raw.replace("512110190592", "512G"),
    raw.replace("512110190592", "-1"), raw.replace("512110190592", "1.5"),
    raw.replace("512110190592", "9007199254740992"),
    raw.replace("512110190592", "NaN"), raw.replace("disk", "disk extra"),
    raw.replace("nvme0n1p1", "└─nvme0n1p1"),
  ])("rejects malformed output without partial success: %j", text => {
    expect(parse(text)).toMatchObject({ parsed: null, parse_error: { reason: "unrecognized_output" } });
  });

  it.each([
    ["--bytes", "--list", "--output=NAME,SIZE,TYPE"],
    ["-bloNAME,SIZE,TYPE"], ["-o", "NAME,SIZE,TYPE", "-lb"],
  ])("accepts equivalent flag spellings: %j", (...flags) => {
    expect(parse(raw, flags)).toEqual({ parsed: { devices } });
  });

  it.each([
    [], ["-l", "-o", "NAME,SIZE,TYPE"], ["-b", "-o", "NAME,SIZE,TYPE"], ["-bl"],
    [...args, "--json"], [...args, "--noheadings"], [...args, "/dev/sda"],
    ["-bl", "-o", "NAME,TYPE,SIZE"], ["-bl", "-o", "NAME,SIZE,TYPE,MOUNTPOINT"],
    ["-bl", "-o", "NAME,SIZE,TYPE", "--output", "NAME"],
  ])("rejects unsupported or incomplete formats: %j", (...flags) => {
    expect(parse(raw, flags)).toMatchObject({ parsed: null, parse_error: { reason: "unsupported_format" } });
  });

  it("limits rows, reports the full count and still validates omitted rows", () => {
    const result = parse(raw, args, 1);
    expect(result).toEqual({ parsed: {
      devices: devices.slice(0, 1), _summary: { total: 3, shown: 1, truncated: true },
    } });
    expect(checkInvariants(result.parsed, raw, registry.contractFor("lsblk", args))).toEqual([]);
    expect(parse(raw + "broken\n", args, 1).parse_error?.reason).toBe("unrecognized_output");
    expect(parse(raw, args, 3)).toEqual({ parsed: { devices } });
  });

  it("replays fixtures against the schema and contract", () => {
    const pack = registry.getPack("lsblk");
    expect(pack).toBeDefined();
    expect(pack!.fixtures.length).toBeGreaterThan(0);
    for (const fixture of pack!.fixtures) {
      expect(pack!.schema.safeParse(fixture.expected).success).toBe(true);
      expect(parse(fixture.input, fixture.args)).toEqual({ parsed: fixture.expected });
      expect(checkInvariants(fixture.expected, fixture.input, pack)).toEqual([]);
    }
  });

  it("preserves compact values and reduces tokens", () => {
    const text = `${header}\n${Array(20).fill(raw.split("\n").slice(1, -1).join("\n")).join("\n")}\n`;
    const result = parse(text);
    const compact = toCompact(result.parsed);
    expect(compact.ok).toBe(true);
    if (!compact.ok) throw new Error(compact.message);
    const table = (compact.value as { devices: { schema: string[]; rows: unknown[][] } }).devices;
    expect(table.rows.map(row => Object.fromEntries(table.schema.map((key, i) => [key, row[i]]))))
      .toEqual(Array(20).fill(devices).flat());
    expect(encode(JSON.stringify(compact.value)).length).toBeLessThan(encode(JSON.stringify(result.parsed)).length);
    const limited = toCompact(parse(text, args, 3).parsed);
    expect(limited.ok).toBe(true);
    if (!limited.ok) throw new Error(limited.message);
    expect(encode(JSON.stringify(limited.value)).length).toBeLessThan(encode(text).length);
    expect(encode(JSON.stringify(limited.value)).length).toBeLessThan(encode(JSON.stringify(compact.value)).length);
  });
});
