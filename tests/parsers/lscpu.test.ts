import { describe, it, expect } from "vitest";
import { encode } from "gpt-tokenizer";
import { createRegistry } from "../../src/parsers/index.js";
import { toCompact } from "../../src/parsers/compact.js";
import { checkInvariants } from "../../src/parsers/invariants.js";

const args = ["--parse=CPU,CORE,SOCKET,NODE"];
const header = "# CPU,Core,Socket,Node";
const raw = `# CPU topology\n${header}\n0,0,0,0\n1,1,0,0\n2,0,1,1\n3,,,\n`;
const cpus = [
  { cpu: 0, core: 0, socket: 0, node: 0 },
  { cpu: 1, core: 1, socket: 0, node: 0 },
  { cpu: 2, core: 0, socket: 1, node: 1 },
  { cpu: 3, core: null, socket: null, node: null },
];
const registry = createRegistry();
const parse = (text: string, flags = args, maxItems = 0) =>
  registry.parse("lscpu", flags, text, { maxItems, format: "json" }, true);

describe("lscpu CPU topology CSV", () => {
  it("reads logical IDs and preserves unavailable topology as null", () => {
    expect(parse(raw)).toEqual({ parsed: { cpus } });
    expect(checkInvariants({ cpus }, raw, registry.contractFor("lscpu", args))).toEqual([]);
    expect(parse(raw, ["-p=cpu,core,socket,node"])).toEqual({ parsed: { cpus } });
  });

  it.each(["", " \n\t", `${header}\n`])("accepts empty output: %j", text => {
    expect(parse(text)).toEqual({ parsed: { cpus: [] } });
  });

  it("handles CRLF and comment lines", () => {
    expect(parse(`${header}\r\n# comment\r\n0,0,0,0\r\n`)).toEqual({ parsed: { cpus: [cpus[0]] } });
  });

  it.each([
    "Architecture: x86_64", "0,0,0,0", "# CPU,Socket,Core,Node\n0,0,0,0\n",
    `${header}\n0,0,0`, `${header}\n0,0,0,0,0`, `${header}\n,0,0,0`,
    `${header}\n-1,0,0,0`, `${header}\n0,1.5,0,0`, `${header}\n0,NaN,0,0`,
    `${header}\n0,9007199254740992,0,0`, `${header}\n0,0,0,-1`,
    raw + "broken\n", raw + header,
  ])("rejects malformed output without partial success: %j", text => {
    expect(parse(text).parse_error?.reason).toBe("unrecognized_output");
  });

  it.each([
    [], ["--parse"], ["-p"], ["--json"], ["--help"], ["--parse=CPU,SOCKET,CORE,NODE"],
    ["--parse=CPU,CORE,SOCKET,NODE", "--physical"], ["--parse", "CPU,CORE,SOCKET,NODE"],
  ].map(flags => [flags]))("rejects other output formats: %j", flags => {
    expect(parse(raw, flags).parse_error?.reason).toBe("unsupported_format");
  });

  it("limits rows while validating the remainder and preserving total counts", () => {
    const result = parse(raw, args, 1);
    expect(result).toEqual({ parsed: {
      cpus: [cpus[0]], _summary: { total: 4, shown: 1, truncated: true },
    } });
    expect(checkInvariants(result.parsed, raw, registry.contractFor("lscpu", args))).toEqual([]);
    expect(parse(raw + "broken\n", args, 1).parse_error?.reason).toBe("unrecognized_output");
    expect(parse(raw, args, 4)).toEqual({ parsed: { cpus } });
  });

  it("replays registered fixtures against their schema and contract", () => {
    const pack = registry.getPack("lscpu");
    expect(pack).toBeDefined();
    expect(pack!.fixtures.length).toBeGreaterThan(0);
    for (const fixture of pack!.fixtures) {
      expect(pack!.schema.safeParse(fixture.expected).success).toBe(true);
      expect(parse(fixture.input, fixture.args)).toEqual({ parsed: fixture.expected });
      expect(checkInvariants(fixture.expected, fixture.input, pack)).toEqual([]);
    }
  });

  it("preserves compact values and saves tokens through compact output and row limits", () => {
    const text = `${header}\n${Array.from({ length: 64 }, (_, cpu) => `${cpu},${cpu % 16},0,0`).join("\n")}\n`;
    const result = parse(text);
    expect(result.parse_error).toBeUndefined();
    const compact = toCompact(result.parsed);
    expect(compact.ok).toBe(true);
    if (!compact.ok) throw new Error(compact.message);
    const table = (compact.value as { cpus: { schema: string[]; rows: unknown[][] } }).cpus;
    expect(table.rows.map(row => Object.fromEntries(table.schema.map((key, i) => [key, row[i]]))))
      .toEqual((result.parsed as { cpus: unknown[] }).cpus);
    expect(encode(JSON.stringify(compact.value)).length).toBeLessThan(encode(JSON.stringify(result.parsed)).length);
    const limited = parse(text, args, 2);
    expect(limited).toEqual({ parsed: {
      cpus: cpus.slice(0, 2), _summary: { total: 64, shown: 2, truncated: true },
    } });
    const limitedCompact = toCompact(limited.parsed);
    expect(limitedCompact.ok).toBe(true);
    if (!limitedCompact.ok) throw new Error(limitedCompact.message);
    expect(encode(JSON.stringify(limitedCompact.value)).length).toBeLessThan(encode(text).length);
  });
});
