import { z } from "zod";
import { UnrecognizedOutputError, type ParserPack } from "../registry.js";
import { collectFlagValues } from "../format.js";

const HEADER = /^NAME\s+SIZE\s+TYPE$/;
const NAME = /^[^\s│├└─]+$/;
const TYPE = /^[a-z][a-z0-9_-]*$/;
const ROW = /^(\S+)\s+(\d+)\s+(\S+)$/;
const integer = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const deviceSchema = z.object({
  name: z.string().regex(NAME),
  size: integer,
  type: z.string().regex(TYPE),
});

/** Explicit byte-sized, flat lsblk table; default columns vary across util-linux versions. */
export const lsblkPack: ParserPack = {
  name: "lsblk",
  meta: { os: ["linux"] },
  acceptedFlags: {
    "-b": "bool", "--bytes": "bool", "-l": "bool", "--list": "bool",
    "-o": "value", "--output": "value",
  },
  acceptedValues: { "-o": /^NAME,SIZE,TYPE$/, "--output": /^NAME,SIZE,TYPE$/ },
  requiredFlags: ["-o", "--output"],
  acceptedPositionals: { max: 0 },
  supports(args) {
    const flags = collectFlagValues(lsblkPack, args);
    return ("-b" in flags || "--bytes" in flags) && ("-l" in flags || "--list" in flags);
  },
  headerLines: 1,
  rowsKey: "devices",
  rowFields: ["name", "size", "type"],
  schema: z.object({
    devices: z.array(deviceSchema),
    _summary: z.object({ total: integer, shown: integer, truncated: z.boolean() }).optional(),
  }),
  parse(raw, _args, ctx) {
    const lines = raw.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
    const devices: z.infer<typeof deviceSchema>[] = [];
    if (lines.length === 0) return { devices };
    if (!HEADER.test(lines[0]!)) throw new UnrecognizedOutputError("Invalid lsblk header");

    let total = 0;
    for (const line of lines.slice(1)) {
      const match = ROW.exec(line);
      if (!match || !NAME.test(match[1]!) || !TYPE.test(match[3]!) || !Number.isSafeInteger(Number(match[2]))) {
        throw new UnrecognizedOutputError("Invalid lsblk device row");
      }
      total++;
      if (!ctx?.maxItems || devices.length < ctx.maxItems) {
        devices.push({ name: match[1]!, size: Number(match[2]), type: match[3]! });
      }
    }
    return {
      devices,
      ...(total > devices.length && { _summary: { total, shown: devices.length, truncated: true } }),
    };
  },
  fixtures: [
    {
      args: ["-b", "-l", "-o", "NAME,SIZE,TYPE"],
      input: "NAME                           SIZE TYPE\nloop0                      52711424 loop\nloop1                     232894464 loop\nloop2                      70049792 loop\nloop3                          4096 loop\n",
      expected: { devices: [
        { name: "loop0", size: 52711424, type: "loop" },
        { name: "loop1", size: 232894464, type: "loop" },
        { name: "loop2", size: 70049792, type: "loop" },
        { name: "loop3", size: 4096, type: "loop" },
      ] },
    },
    {
      args: ["--bytes", "--list", "--output=NAME,SIZE,TYPE"],
      input: "NAME SIZE TYPE\nvda 10737418240 disk\nvda1 10736369664 part\nvg-root 8589934592 lvm\n",
      expected: { devices: [
        { name: "vda", size: 10737418240, type: "disk" },
        { name: "vda1", size: 10736369664, type: "part" },
        { name: "vg-root", size: 8589934592, type: "lvm" },
      ] },
    },
    { args: ["-bl", "-o", "NAME,SIZE,TYPE"], input: "", expected: { devices: [] } },
    { args: ["-bl", "-o", "NAME,SIZE,TYPE"], input: "NAME SIZE TYPE\n", expected: { devices: [] } },
  ],
};
