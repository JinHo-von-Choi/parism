import { z } from "zod";
import { UnrecognizedOutputError, type ParserPack } from "../registry.js";

const HEADER = "# CPU,Core,Socket,Node";
const COLUMNS = /^CPU,CORE,SOCKET,NODE$/i;
const integer = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const cpuSchema = z.object({
  cpu: integer,
  core: integer.nullable(),
  socket: integer.nullable(),
  node: integer.nullable(),
});

/** Explicit util-linux topology columns; missing topology IDs remain null. */
export const lscpuPack: ParserPack = {
  name: "lscpu",
  meta: { os: ["linux"] },
  acceptedFlags: { "--parse": "value", "-p": "value" },
  acceptedValues: { "--parse": COLUMNS, "-p": /^=CPU,CORE,SOCKET,NODE$/i },
  requiredFlags: ["--parse", "-p"],
  acceptedPositionals: { max: 0 },
  // lscpu's optional column argument must be attached with '='.
  supports: args => args.length === 1 && /^(?:--parse|-p)=CPU,CORE,SOCKET,NODE$/i.test(args[0]!),
  noise: /^\s*#/,
  rowsKey: "cpus",
  rowFields: ["cpu", "core", "socket", "node"],
  schema: z.object({
    cpus: z.array(cpuSchema),
    _summary: z.object({ total: integer, shown: integer, truncated: z.boolean() }).optional(),
  }),
  parse(raw, _args, ctx) {
    const lines = raw.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
    const cpus: z.infer<typeof cpuSchema>[] = [];
    if (lines.length === 0) return { cpus };

    let headerSeen = false;
    let total = 0;
    for (const line of lines) {
      if (line === HEADER) {
        if (headerSeen) throw new UnrecognizedOutputError("Duplicate lscpu header");
        headerSeen = true;
        continue;
      }
      if (line.startsWith("#")) continue;
      const fields = line.split(",");
      if (!headerSeen || fields.length !== 4 || !/^\d+$/.test(fields[0]!) ||
          fields.some(field => field !== "" && (!/^\d+$/.test(field) || !Number.isSafeInteger(Number(field))))) {
        throw new UnrecognizedOutputError("Invalid lscpu topology row");
      }
      total++;
      if (!ctx?.maxItems || cpus.length < ctx.maxItems) {
        cpus.push({
          cpu: Number(fields[0]),
          core: fields[1] === "" ? null : Number(fields[1]),
          socket: fields[2] === "" ? null : Number(fields[2]),
          node: fields[3] === "" ? null : Number(fields[3]),
        });
      }
    }
    if (!headerSeen) throw new UnrecognizedOutputError("Invalid lscpu header");
    return {
      cpus,
      ...(total > cpus.length && { _summary: { total, shown: cpus.length, truncated: true } }),
    };
  },
  fixtures: [
    {
      args: ["--parse=CPU,CORE,SOCKET,NODE"],
      input: "# The following is the parsable format, which can be fed to other\n# programs. Each different item in every column has an unique ID\n# starting usually from zero.\n# CPU,Core,Socket,Node\n0,0,0,0\n1,1,0,0\n2,2,0,0\n3,3,0,0\n",
      expected: { cpus: [
        { cpu: 0, core: 0, socket: 0, node: 0 },
        { cpu: 1, core: 1, socket: 0, node: 0 },
        { cpu: 2, core: 2, socket: 0, node: 0 },
        { cpu: 3, core: 3, socket: 0, node: 0 },
      ] },
    },
    {
      args: ["-p=CPU,CORE,SOCKET,NODE"],
      input: "# CPU,Core,Socket,Node\n0,,,\n",
      expected: { cpus: [{ cpu: 0, core: null, socket: null, node: null }] },
    },
    { args: ["--parse=CPU,CORE,SOCKET,NODE"], input: "", expected: { cpus: [] } },
    { args: ["--parse=CPU,CORE,SOCKET,NODE"], input: "# CPU,Core,Socket,Node\n", expected: { cpus: [] } },
  ],
};
