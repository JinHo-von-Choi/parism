import { z } from "zod";
import { UnrecognizedOutputError, type ParserPack } from "../registry.js";

const SLOT = /^(?:[0-9a-fA-F]{4}:)?[0-9a-fA-F]{2}:[01][0-9a-fA-F]\.[0-7]$/;
const ROW = /^((?:[0-9a-fA-F]{4}:)?[0-9a-fA-F]{2}:[01][0-9a-fA-F]\.[0-7])\s+([^:]+):\s+(\S.*)$/;
const deviceSchema = z.object({
  slot: z.string().regex(SLOT),
  class: z.string().min(1),
  description: z.string().min(1),
});
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

/** pciutils brief list; descriptions retain revision numbers and device names verbatim. */
export const lspciPack: ParserPack = {
  name: "lspci",
  meta: { os: ["linux"] },
  acceptedFlags: { "-D": "bool" },
  acceptedPositionals: { max: 0 },
  rowsKey: "devices",
  rowFields: ["slot", "class", "description"],
  schema: z.object({
    devices: z.array(deviceSchema),
    _summary: z.object({ total: count, shown: count, truncated: z.boolean() }).optional(),
  }),
  parse(raw, _args, ctx) {
    const devices: z.infer<typeof deviceSchema>[] = [];
    let total = 0;
    for (const line of raw.split(/\r?\n/)) {
      const text = line.trim();
      if (!text) continue;
      const match = ROW.exec(text);
      if (!match || !match[2]!.trim()) throw new UnrecognizedOutputError("Invalid lspci device row");
      total++;
      if (!ctx?.maxItems || devices.length < ctx.maxItems) {
        devices.push({ slot: match[1]!, class: match[2]!.trim(), description: match[3]! });
      }
    }
    return {
      devices,
      ...(total > devices.length && { _summary: { total, shown: devices.length, truncated: true } }),
    };
  },
  fixtures: [
    {
      args: [],
      input: "00:00.0 Host bridge: Intel Corporation Xeon E7 v4/Xeon E5 v4/Xeon E3 v4/Xeon D DMI2 (rev 01)\n" +
        "00:01.0 PCI bridge: Intel Corporation Xeon E7 v4/Xeon E5 v4/Xeon E3 v4/Xeon D PCI Express Root Port 1 (rev 01)\n",
      expected: { devices: [
        { slot: "00:00.0", class: "Host bridge", description: "Intel Corporation Xeon E7 v4/Xeon E5 v4/Xeon E3 v4/Xeon D DMI2 (rev 01)" },
        { slot: "00:01.0", class: "PCI bridge", description: "Intel Corporation Xeon E7 v4/Xeon E5 v4/Xeon E3 v4/Xeon D PCI Express Root Port 1 (rev 01)" },
      ] },
    },
    { args: [], input: "", expected: { devices: [] } },
    {
      args: ["-D"], input: "0001:01:00.0 Ethernet controller: Vendor Device 1234\n",
      expected: { devices: [{ slot: "0001:01:00.0", class: "Ethernet controller", description: "Vendor Device 1234" }] },
    },
  ],
};
