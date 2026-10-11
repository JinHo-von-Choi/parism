import { z } from "zod";
import { UnrecognizedOutputError, type ParserPack } from "../registry.js";

const HEADER = /^Module\s+Size\s+Used by$/;
const NAME = /^[A-Za-z0-9_-]+$/;
const ROW = /^([A-Za-z0-9_-]+)\s+(\d+)\s+(\d+)(?:\s+([A-Za-z0-9_-]+(?:,[A-Za-z0-9_-]+)*))?$/;
const integer = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const moduleSchema = z.object({
  name: z.string().regex(NAME),
  size: integer,
  used: integer,
  usedBy: z.array(z.string().regex(NAME)),
});

/** Linux lsmod table: size is bytes; used counts references, not just dependent modules. */
export const lsmodPack: ParserPack = {
  name: "lsmod",
  meta: { os: ["linux"] },
  acceptedFlags: {},
  acceptedPositionals: { max: 0 },
  headerLines: 1,
  rowsKey: "modules",
  rowFields: ["name", "size", "used", "usedBy"],
  schema: z.object({
    modules: z.array(moduleSchema),
    _summary: z.object({ total: integer, shown: integer, truncated: z.boolean() }).optional(),
  }),
  parse(raw, _args, ctx) {
    const lines = raw.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
    const modules: z.infer<typeof moduleSchema>[] = [];
    if (lines.length === 0) return { modules };
    if (!HEADER.test(lines[0]!)) throw new UnrecognizedOutputError("Invalid lsmod header");

    let total = 0;
    for (const line of lines.slice(1)) {
      const match = ROW.exec(line);
      if (!match || !Number.isSafeInteger(Number(match[2])) || !Number.isSafeInteger(Number(match[3]))) {
        throw new UnrecognizedOutputError("Invalid lsmod module row");
      }
      total++;
      if (!ctx?.maxItems || modules.length < ctx.maxItems) {
        modules.push({
          name: match[1]!, size: Number(match[2]), used: Number(match[3]),
          usedBy: match[4]?.split(",") ?? [],
        });
      }
    }
    return {
      modules,
      ...(total > modules.length && { _summary: { total, shown: modules.length, truncated: true } }),
    };
  },
  fixtures: [
    {
      args: [],
      input: "Module                  Size  Used by\nmptcp_diag             12288  0\nhid                   180224  2 usbhid,hid_generic\ncryptd                 24576  2 crypto_simd,ghash_clmulni_intel\n",
      expected: { modules: [
        { name: "mptcp_diag", size: 12288, used: 0, usedBy: [] },
        { name: "hid", size: 180224, used: 2, usedBy: ["usbhid", "hid_generic"] },
        { name: "cryptd", size: 24576, used: 2, usedBy: ["crypto_simd", "ghash_clmulni_intel"] },
      ] },
    },
    { args: [], input: "", expected: { modules: [] } },
    { args: [], input: "Module                  Size  Used by\n", expected: { modules: [] } },
  ],
};
