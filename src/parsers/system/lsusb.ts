import { z } from "zod";
import { UnrecognizedOutputError, type ParserPack } from "../registry.js";

const ROW = /^Bus\s+(\d{3})\s+Device\s+(\d{3}):\s+ID\s+([0-9a-fA-F]{4}):([0-9a-fA-F]{4})(?:\s+(.*))?$/;
const usbId = z.string().regex(/^[0-9a-fA-F]{4}$/);
const deviceSchema = z.object({
  bus: z.number().int().nonnegative().max(999),
  device: z.number().int().nonnegative().max(999),
  vendorId: usbId,
  productId: usbId,
  description: z.string(),
});
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

/** Default usbutils lsusb list; verbose descriptors and tree output have different formats. */
export const lsusbPack: ParserPack = {
  name: "lsusb",
  meta: { os: ["linux"] },
  acceptedFlags: {},
  acceptedPositionals: { max: 0 },
  rowsKey: "devices",
  rowFields: ["bus", "device", "vendorId", "productId", "description"],
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
      if (!match) throw new UnrecognizedOutputError("Invalid lsusb device row");
      total++;
      if (!ctx?.maxItems || devices.length < ctx.maxItems) {
        devices.push({
          bus: Number(match[1]), device: Number(match[2]),
          vendorId: match[3]!, productId: match[4]!, description: match[5] ?? "",
        });
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
      input: "Bus 001 Device 001: ID 1d6b:0002 Linux Foundation 2.0 root hub\n" +
        "Bus 001 Device 002: ID 8087:800a Intel Corp. Hub\n" +
        "Bus 002 Device 001: ID 1d6b:0002 Linux Foundation 2.0 root hub\n" +
        "Bus 002 Device 002: ID 8087:8002 Intel Corp. 8 channel internal hub\n" +
        "Bus 003 Device 001: ID 1d6b:0001 Linux Foundation 1.1 root hub\n" +
        "Bus 004 Device 001: ID 1d6b:0002 Linux Foundation 2.0 root hub\n" +
        "Bus 004 Device 002: ID 0424:2660 Microchip Technology, Inc. (formerly SMSC) Hub\n" +
        "Bus 005 Device 001: ID 1d6b:0003 Linux Foundation 3.0 root hub\n",
      expected: { devices: [
        { bus: 1, device: 1, vendorId: "1d6b", productId: "0002", description: "Linux Foundation 2.0 root hub" },
        { bus: 1, device: 2, vendorId: "8087", productId: "800a", description: "Intel Corp. Hub" },
        { bus: 2, device: 1, vendorId: "1d6b", productId: "0002", description: "Linux Foundation 2.0 root hub" },
        { bus: 2, device: 2, vendorId: "8087", productId: "8002", description: "Intel Corp. 8 channel internal hub" },
        { bus: 3, device: 1, vendorId: "1d6b", productId: "0001", description: "Linux Foundation 1.1 root hub" },
        { bus: 4, device: 1, vendorId: "1d6b", productId: "0002", description: "Linux Foundation 2.0 root hub" },
        { bus: 4, device: 2, vendorId: "0424", productId: "2660", description: "Microchip Technology, Inc. (formerly SMSC) Hub" },
        { bus: 5, device: 1, vendorId: "1d6b", productId: "0003", description: "Linux Foundation 3.0 root hub" },
      ] },
    },
    { args: [], input: "", expected: { devices: [] } },
    {
      args: [], input: "Bus 002 Device 003: ID abcd:00ef\n",
      expected: { devices: [{ bus: 2, device: 3, vendorId: "abcd", productId: "00ef", description: "" }] },
    },
  ],
};
