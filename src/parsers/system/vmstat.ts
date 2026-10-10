import { z } from "zod";
import { UnrecognizedOutputError, type ParserPack } from "../registry.js";

const FIELDS = ["r", "b", "swpd", "free", "buff", "cache", "si", "so", "bi", "bo", "in", "cs", "us", "sy", "id", "wa", "st"] as const;
const GROUP = /^procs\s+-+memory-+\s+-+swap-+\s+-+io-+\s+-+system-+\s+-+cpu-+$/;
const HEADER = /^r\s+b\s+swpd\s+free\s+buff\s+cache\s+si\s+so\s+bi\s+bo\s+in\s+cs\s+us\s+sy\s+id\s+wa\s+st(?:\s+gu)?$/;
const integer = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const sampleSchema = z.object({
  r: integer, b: integer, swpd: integer, free: integer, buff: integer, cache: integer,
  si: integer, so: integer, bi: integer, bo: integer, in: integer, cs: integer,
  us: integer, sy: integer, id: integer, wa: integer, st: integer, gu: integer.optional(),
});

/** Linux VM mode: memory and swap use KiB; bi/bo use KiB/s, CPU fields use percent. */
export const vmstatPack: ParserPack = {
  name: "vmstat",
  meta: { os: ["linux"] },
  acceptedFlags: { "-n": "bool", "--one-header": "bool" },
  acceptedPositionals: { max: 2, pattern: /^[1-9]\d*$/ },
  noise: /^\s*(?:procs\s+-+memory-+\s+-+swap-+\s+-+io-+\s+-+system-+\s+-+cpu-+|r\s+b\s+swpd\s+free\s+buff\s+cache\s+si\s+so\s+bi\s+bo\s+in\s+cs\s+us\s+sy\s+id\s+wa\s+st(?:\s+gu)?)\s*$/,
  rowsKey: "samples",
  rowFields: [...FIELDS, "gu"],
  schema: z.object({
    unit: z.literal("KiB"),
    samples: z.array(sampleSchema),
    _summary: z.object({ total: integer, shown: integer, truncated: z.boolean() }).optional(),
  }),
  parse(raw, _args, ctx) {
    const samples: z.infer<typeof sampleSchema>[] = [];
    let fields: string[] | undefined;
    let awaitingHeader = false;
    let total = 0;
    for (const line of raw.split(/\r?\n/).map(l => l.trim()).filter(Boolean)) {
      if (GROUP.test(line)) {
        if (awaitingHeader) throw new UnrecognizedOutputError("Missing vmstat column header");
        awaitingHeader = true;
        continue;
      }
      if (awaitingHeader && HEADER.test(line)) {
        const next = line.split(/\s+/);
        if (fields && next.join(" ") !== fields.join(" ")) {
          throw new UnrecognizedOutputError("Inconsistent vmstat columns");
        }
        fields = next;
        awaitingHeader = false;
        continue;
      }
      const values = line.split(/\s+/);
      if (awaitingHeader || !fields || values.length !== fields.length ||
          values.some(value => !/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)))) {
        throw new UnrecognizedOutputError("Invalid vmstat header or sample");
      }
      total++;
      if (!ctx?.maxItems || samples.length < ctx.maxItems) {
        samples.push(Object.fromEntries(fields.map((field, i) => [field, Number(values[i])])) as z.infer<typeof sampleSchema>);
      }
    }
    if (awaitingHeader) throw new UnrecognizedOutputError("Missing vmstat column header");
    return {
      unit: "KiB", samples,
      ...(total > samples.length && { _summary: { total, shown: samples.length, truncated: true } }),
    };
  },
  fixtures: [
    {
      args: [],
      input: "procs -----------memory---------- ---swap-- -----io---- -system-- -------cpu-------\n r  b   swpd   free   buff  cache   si   so    bi    bo   in   cs us sy id wa st gu\n 7  0 13828748 12804456 3476588 65059760    6   27   538  4850 16692    3  7  1 92  0  0  0\n",
      expected: { unit: "KiB", samples: [{
        r: 7, b: 0, swpd: 13828748, free: 12804456, buff: 3476588, cache: 65059760,
        si: 6, so: 27, bi: 538, bo: 4850, in: 16692, cs: 3, us: 7, sy: 1, id: 92, wa: 0, st: 0, gu: 0,
      }] },
    },
    { args: [], input: "", expected: { unit: "KiB", samples: [] } },
  ],
};
