import { z } from "zod";
import { UnrecognizedOutputError, type ParserPack } from "../registry.js";

const states = ["UNKNOWN", "NOTPRESENT", "DOWN", "LOWERLAYERDOWN", "TESTING", "DORMANT", "UP"] as const;
const addressSchema = z.union([
  z.string().regex(/^(?:[\da-f]{2}:){5}[\da-f]{2}$|^(?:[\da-f]{2}:){7}[\da-f]{2}$|^(?:[\da-f]{2}:){19}[\da-f]{2}$/i),
  z.ipv4(),
  z.ipv6(),
]);
const ROW = /^(\S+)\s+(\S+)\s+(?:(\S+)\s+)?<([A-Z][A-Z0-9_-]*(?:,[A-Z][A-Z0-9_-]*)*|)>$/;
const integer = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const interfaceSchema = z.object({
  name: z.string().min(1),
  state: z.enum(states),
  address: addressSchema.nullable(),
  flags: z.array(z.string().regex(/^[A-Z][A-Z0-9_-]*$/)),
});

/** iproute2 brief link table, including peer suffixes and interfaces without a link address. */
export const ipPack: ParserPack = {
  name: "ip",
  meta: { os: ["linux"] },
  acceptedFlags: { "-brief": "bool", "-br": "bool" },
  singleDashLong: true,
  requiredFlags: ["-brief", "-br"],
  acceptedPositionals: { min: 1, max: 2, pattern: /^(link|show)$/ },
  supports: args => (args[0] === "-brief" || args[0] === "-br") && args[1] === "link" &&
    (args.length === 2 || (args.length === 3 && args[2] === "show")),
  rowsKey: "interfaces",
  rowFields: ["name", "state", "address", "flags"],
  schema: z.object({
    interfaces: z.array(interfaceSchema),
    _summary: z.object({ total: integer, shown: integer, truncated: z.boolean() }).optional(),
  }),
  parse(raw, _args, ctx) {
    const interfaces: z.infer<typeof interfaceSchema>[] = [];
    let total = 0;
    for (const line of raw.split(/\r?\n/).map(line => line.trim()).filter(Boolean)) {
      const match = ROW.exec(line);
      if (!match || !states.includes(match[2] as typeof states[number]) ||
          (match[3] !== undefined && !addressSchema.safeParse(match[3]).success)) {
        throw new UnrecognizedOutputError("Invalid ip brief link row");
      }
      total++;
      if (!ctx?.maxItems || interfaces.length < ctx.maxItems) {
        interfaces.push({
          name: match[1]!, state: match[2] as typeof states[number],
          address: match[3] ?? null, flags: match[4] ? match[4].split(",") : [],
        });
      }
    }
    return {
      interfaces,
      ...(total > interfaces.length && { _summary: { total, shown: interfaces.length, truncated: true } }),
    };
  },
  fixtures: [
    {
      args: ["-brief", "link"],
      input: "lo               UNKNOWN        00:00:00:00:00:00 <LOOPBACK,UP,LOWER_UP>\n" +
        "eth0@if2         UP             02:00:00:00:00:01 <BROADCAST,MULTICAST,UP,LOWER_UP>\n",
      expected: { interfaces: [
        { name: "lo", state: "UNKNOWN", address: "00:00:00:00:00:00", flags: ["LOOPBACK", "UP", "LOWER_UP"] },
        { name: "eth0@if2", state: "UP", address: "02:00:00:00:00:01", flags: ["BROADCAST", "MULTICAST", "UP", "LOWER_UP"] },
      ] },
    },
    {
      args: ["-br", "link", "show"], input: "tun0 DOWN <POINTOPOINT,NOARP>\n",
      expected: { interfaces: [{ name: "tun0", state: "DOWN", address: null, flags: ["POINTOPOINT", "NOARP"] }] },
    },
    { args: ["-brief", "link"], input: "", expected: { interfaces: [] } },
  ],
};
