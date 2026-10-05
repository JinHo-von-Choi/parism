import { z } from "zod";
import {
  UnrecognizedOutputError,
  type ParseContext,
  type ParserPack,
} from "../registry.js";

const interfaceSchema = z.object({
  name:  z.string(),
  state: z.string().nullable(),
  mac:   z.string().nullable(),
  ipv4:  z.array(z.string()),
  ipv6:  z.array(z.string()),
});

export const ipAddressSchema = z.object({
  interfaces: z.array(interfaceSchema),
  _summary: z.object({
    total:     z.number().int().nonnegative(),
    shown:     z.number().int().nonnegative(),
    truncated: z.literal(true),
  }).optional(),
});

export type IpAddressResult = z.infer<typeof ipAddressSchema>;
type IpInterface = z.infer<typeof interfaceSchema>;

const INTERFACE_LINE = /^(\d+):\s+([^:]+):\s*(?:<([^>]*)>\s*)?(.*)$/;
const ADDRESS_LINE   = /^\s+(inet6?)\s+(\S+).*?\bscope\s+(\S+)/;

function parseInterfaceName(value: string): string {
  const separator = value.indexOf("@");
  return separator < 0 ? value : value.slice(0, separator);
}

function parseIpAddress(raw: string, ctx?: ParseContext): IpAddressResult {
  if (!raw.trim()) return { interfaces: [] };

  const interfaces: IpInterface[] = [];
  let current: IpInterface | undefined;

  for (const line of raw.split(/\r?\n/)) {
    const header = INTERFACE_LINE.exec(line);
    if (header) {
      const tail  = header[4] ?? "";
      const state = /(?:^|\s)state\s+(\S+)(?:\s|$)/.exec(tail);

      current = {
        name:  parseInterfaceName(header[2]!),
        state: state?.[1] ?? null,
        mac:   null,
        ipv4:  [],
        ipv6:  [],
      };
      interfaces.push(current);
      continue;
    }

    if (!current) continue;

    const link = /^\s+link\/\S+\s+(\S+)/.exec(line);
    if (link) {
      current.mac = link[1] ?? null;
      continue;
    }

    const address = ADDRESS_LINE.exec(line);
    if (address) {
      (address[1] === "inet" ? current.ipv4 : current.ipv6).push(address[2]!);
    }
  }

  if (interfaces.length === 0) {
    throw new UnrecognizedOutputError("no interface records found in ip address output");
  }

  const maxItems = ctx?.maxItems ?? 0;
  if (maxItems > 0 && interfaces.length > maxItems) {
    return {
      interfaces: interfaces.slice(0, maxItems),
      _summary: { total: interfaces.length, shown: maxItems, truncated: true },
    };
  }

  return { interfaces };
}

const representativeFixture = [
  "1: lo: <LOOPBACK,UP,LOWER_UP> mtu 65536 qdisc noqueue state UNKNOWN group default qlen 1000",
  "    link/loopback 00:00:00:00:00:00 brd 00:00:00:00:00:00",
  "    inet 127.0.0.1/8 scope host lo",
  "       valid_lft forever preferred_lft forever",
  "2: eth0@if7: <BROADCAST,MULTICAST,UP,LOWER_UP> mtu 1500 qdisc noqueue state UP group default",
  "    link/ether 02:42:ac:11:00:02 brd ff:ff:ff:ff:ff:ff",
  "    inet 172.17.0.2/16 brd 172.17.255.255 scope global eth0",
].join("\n");

const addressContract = {
  acceptedFlags:       {},
  acceptedPositionals: { max: 0 },
} as const;

const ipPack: ParserPack = {
  name:  "ip",
  parse: (raw, _args, ctx) => parseIpAddress(raw, ctx),
  schema: ipAddressSchema,
  leadingFlags: { "-4": "bool", "-6": "bool" },
  subcommands: {
    "address show": addressContract,
    "addr show":    addressContract,
    address:         addressContract,
    addr:            addressContract,
  },
  fixtures: [
    {
      input: representativeFixture,
      args:  ["address", "show"],
      expected: {
        interfaces: [
          {
            name: "lo", state: "UNKNOWN", mac: "00:00:00:00:00:00", ipv4: ["127.0.0.1/8"], ipv6: [],
          },
          {
            name: "eth0", state: "UP", mac: "02:42:ac:11:00:02", ipv4: ["172.17.0.2/16"], ipv6: [],
          },
        ],
      },
    },
    { input: "", args: ["addr", "show"], expected: { interfaces: [] } },
  ],
  meta: { os: ["linux"] },
};

export default ipPack;
