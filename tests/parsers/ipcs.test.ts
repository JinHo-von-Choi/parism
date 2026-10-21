import { describe, it, expect } from "vitest";
import { encode } from "gpt-tokenizer";
import { createRegistry } from "../../src/parsers/index.js";
import { toCompact } from "../../src/parsers/compact.js";
import { checkInvariants } from "../../src/parsers/invariants.js";

const header = "\n------ Shared Memory Segments --------\nkey        shmid      owner      perms      bytes      nattch     status\n";
const rows = "0x00488a37 16         postgres   600        56         45\n" +
  "0x00000000 32769      root       660        1048576    2          dest\n" +
  "0x1234abcd 42         1000       0600       4096       0          locked\n" +
  "0x00000000 43         app-user   600        8192       1          dest locked\n";
const raw = header + rows;
const segments = [
  { key: "0x00488a37", shmid: 16, owner: "postgres", perms: "600", bytes: 56, nattch: 45, status: "" },
  { key: "0x00000000", shmid: 32769, owner: "root", perms: "660", bytes: 1048576, nattch: 2, status: "dest" },
  { key: "0x1234abcd", shmid: 42, owner: "1000", perms: "0600", bytes: 4096, nattch: 0, status: "locked" },
  { key: "0x00000000", shmid: 43, owner: "app-user", perms: "600", bytes: 8192, nattch: 1, status: "dest locked" },
];
const registry = createRegistry();
const parse = (text: string, args = ["-m"], maxItems = 0) =>
  registry.parse("ipcs", args, text, { maxItems, format: "json" }, true);

describe("ipcs shared memory", () => {
  it.each([["-m"], ["--shmems"], ["-m", "-b"], ["--shmems", "--bytes"]].map(args => [args]))(
    "reads shared memory segments with %j", args => {
      expect(parse(raw, args)).toEqual({ parsed: { segments } });
      expect(checkInvariants({ segments }, raw, registry.contractFor("ipcs", args))).toEqual([]);
    },
  );

  it.each(["", " \n\t", header])("accepts empty output: %j", text => {
    expect(parse(text)).toEqual({ parsed: { segments: [] } });
  });

  it("handles CRLF and variable whitespace without losing permission zeroes", () => {
    expect(parse(raw.replaceAll("\n", "\r\n").replace(/ +/g, "\t")))
      .toEqual({ parsed: { segments } });
  });

  it.each([
    "not ipcs output", rows, "------ Shared Memory Segments --------\n",
    raw.replace("nattch", "attachments"), raw + "broken row\n",
    raw.replace("0x00488a37", "0xinvalid"), raw.replace("600", "689"),
    raw.replace("56", "1.5"), raw.replace("56", "-1"),
    raw.replace("56", "9007199254740992"), raw.replace("16 ", "9007199254740992 "),
    raw.replace("45", "9007199254740992"), raw.replace("dest\n", "unknown\n"),
    raw + header,
  ])("rejects malformed output without partial results: %j", text => {
    expect(parse(text)).toMatchObject({ parsed: null, parse_error: { reason: "unrecognized_output" } });
  });

  it.each([[], ["-q"], ["-s"], ["-a"], ["-m", "-q"], ["-m", "--human"],
    ["-m", "-t"], ["-m", "-p"], ["-m", "-c"], ["-m", "-l"], ["-m", "-u"],
    ["-m", "-i", "16"], ["-m", "extra"], ["--help"], ["--version"]].map(args => [args]))(
    "rejects unsupported output formats: %j", args => {
      expect(parse(raw, args).parse_error?.reason).toBe("unsupported_format");
    },
  );

  it("limits rows but validates the entire table and reports omitted rows", () => {
    const result = parse(raw, ["-m"], 1);
    expect(result).toEqual({ parsed: {
      segments: segments.slice(0, 1), _summary: { total: 4, shown: 1, truncated: true },
    } });
    expect(checkInvariants(result.parsed, raw, registry.contractFor("ipcs", ["-m"]))).toEqual([]);
    expect(parse(raw + "broken\n", ["-m"], 1).parse_error?.reason).toBe("unrecognized_output");
    expect(parse(raw, ["-m"], 4)).toEqual({ parsed: { segments } });
  });

  it("replays registered fixtures against the schema and contract", () => {
    const pack = registry.getPack("ipcs");
    expect(pack).toBeDefined();
    expect(pack!.fixtures.length).toBeGreaterThan(0);
    for (const fixture of pack!.fixtures) {
      expect(pack!.schema.safeParse(fixture.expected).success).toBe(true);
      expect(parse(fixture.input, fixture.args)).toEqual({ parsed: fixture.expected });
      expect(checkInvariants(fixture.expected, fixture.input, pack)).toEqual([]);
    }
  });

  it("reduces tokens with lossless compact rows and explicit row limits", () => {
    const text = header + rows.repeat(20);
    const result = parse(text);
    expect(result.parse_error).toBeUndefined();
    const compact = toCompact(result.parsed);
    if (!compact.ok) throw new Error(compact.message);
    const table = (compact.value as { segments: { schema: string[]; rows: unknown[][] } }).segments;
    expect(table.rows.map(row => Object.fromEntries(table.schema.map((key, i) => [key, row[i]]))))
      .toEqual(Array(20).fill(segments).flat());
    expect(encode(JSON.stringify(compact.value)).length).toBeLessThan(encode(JSON.stringify(result.parsed)).length);
    expect(encode(JSON.stringify(compact.value)).length).toBeLessThan(encode(text).length);
    const limited = parse(text, ["-m"], 4);
    expect(limited).toEqual({ parsed: {
      segments, _summary: { total: 80, shown: 4, truncated: true },
    } });
    const limitedCompact = toCompact(limited.parsed);
    if (!limitedCompact.ok) throw new Error(limitedCompact.message);
    expect(encode(JSON.stringify(limitedCompact.value)).length).toBeLessThan(encode(text).length);
  });
});
