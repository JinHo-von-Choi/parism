import { z } from "zod";
import { UnrecognizedOutputError, type ParserPack } from "../registry.js";

const HEADER = /^NAME\s+TYPE\s+SIZE\s+USED\s+PRIO$/;
const SIZE = /^\d+(?:\.\d+)?[BKMGTPEZY]$/;
const ROW = /^(\S(?:.*\S)?)\s+(file|partition)\s+(\S+)\s+(\S+)\s+(-?\d+)$/;
const integer = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const swapSchema = z.object({
  name: z.string().min(1),
  type: z.enum(["file", "partition"]),
  size: z.string().regex(SIZE),
  used: z.string().regex(SIZE),
  priority: z.number().int().min(Number.MIN_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER),
});

/** Default util-linux swapon table; keep human-readable sizes and their units. */
export const swaponPack: ParserPack = {
  name: "swapon",
  meta: { os: ["linux"] },
  acceptedFlags: { "--show": "bool" },
  requiredFlags: ["--show"],
  acceptedPositionals: { max: 0 },
  headerLines: 1,
  rowsKey: "swaps",
  rowFields: ["name", "type", "size", "used", "priority"],
  schema: z.object({
    swaps: z.array(swapSchema),
    _summary: z.object({ total: integer, shown: integer, truncated: z.boolean() }).optional(),
  }),
  parse(raw, _args, ctx) {
    const lines = raw.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
    const swaps: z.infer<typeof swapSchema>[] = [];
    if (lines.length === 0) return { swaps };
    if (!HEADER.test(lines[0]!)) throw new UnrecognizedOutputError("Invalid swapon header");

    let total = 0;
    for (const line of lines.slice(1)) {
      const match = ROW.exec(line);
      if (!match || !SIZE.test(match[3]!) || !SIZE.test(match[4]!) || !Number.isSafeInteger(Number(match[5]))) {
        throw new UnrecognizedOutputError("Invalid swapon row");
      }
      total++;
      if (!ctx?.maxItems || swaps.length < ctx.maxItems) {
        swaps.push({
          name: match[1]!, type: match[2] as "file" | "partition",
          size: match[3]!, used: match[4]!, priority: Number(match[5]),
        });
      }
    }
    return {
      swaps,
      ...(total > swaps.length && { _summary: { total, shown: swaps.length, truncated: true } }),
    };
  },
  fixtures: [
    {
      args: ["--show"],
      input: "NAME      TYPE SIZE  USED PRIO\n/swap.img file  32G 13.1G   -2\n",
      expected: { swaps: [
        { name: "/swap.img", type: "file", size: "32G", used: "13.1G", priority: -2 },
      ] },
    },
    {
      args: ["--show"],
      input: "NAME       TYPE      SIZE USED PRIO\n/dev/zram0 partition   8G   0B  100\n",
      expected: { swaps: [
        { name: "/dev/zram0", type: "partition", size: "8G", used: "0B", priority: 100 },
      ] },
    },
    { args: ["--show"], input: "", expected: { swaps: [] } },
    { args: ["--show"], input: "NAME TYPE SIZE USED PRIO\n", expected: { swaps: [] } },
  ],
};
