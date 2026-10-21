import { z } from "zod";
import { UnrecognizedOutputError, type ParserPack } from "../registry.js";

const TITLE = /^------\s+Shared\s+Memory\s+Segments\s+--------$/;
const HEADER = /^key\s+shmid\s+owner\s+perms\s+bytes\s+nattch\s+status$/;
const KEY = /^0x[\da-fA-F]{8}$/;
const PERMS = /^[0-7]{1,4}$/;
const ROW = /^(0x[\da-fA-F]{8})\s+(\d+)\s+(\S+)\s+([0-7]{1,4})\s+(\d+)\s+(\d+)(?:\s+(dest(?:\s+locked)?|locked))?$/;
const integer = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const segmentSchema = z.object({
  key: z.string().regex(KEY),
  shmid: integer,
  owner: z.string().min(1),
  perms: z.string().regex(PERMS),
  bytes: integer,
  nattch: integer,
  status: z.enum(["", "dest", "locked", "dest locked"]),
});

/** util-linux shared memory table; permissions remain octal strings and sizes are bytes. */
export const ipcsPack: ParserPack = {
  name: "ipcs",
  meta: { os: ["linux"] },
  acceptedFlags: { "-m": "bool", "--shmems": "bool", "-b": "bool", "--bytes": "bool" },
  requiredFlags: ["-m", "--shmems"],
  acceptedPositionals: { max: 0 },
  headerLines: 2,
  rowsKey: "segments",
  rowFields: ["key", "shmid", "owner", "perms", "bytes", "nattch", "status"],
  schema: z.object({
    segments: z.array(segmentSchema),
    _summary: z.object({ total: integer, shown: integer, truncated: z.boolean() }).optional(),
  }),
  parse(raw, _args, ctx) {
    const lines = raw.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
    const segments: z.infer<typeof segmentSchema>[] = [];
    if (lines.length === 0) return { segments };
    if (!TITLE.test(lines[0]!) || !HEADER.test(lines[1] ?? "")) {
      throw new UnrecognizedOutputError("Invalid ipcs shared memory header");
    }

    let total = 0;
    for (const line of lines.slice(2)) {
      const match = ROW.exec(line);
      if (!match || ![match[2], match[5], match[6]].every(value => Number.isSafeInteger(Number(value)))) {
        throw new UnrecognizedOutputError("Invalid ipcs shared memory row");
      }
      total++;
      if (!ctx?.maxItems || segments.length < ctx.maxItems) {
        segments.push({
          key: match[1]!, shmid: Number(match[2]), owner: match[3]!, perms: match[4]!,
          bytes: Number(match[5]), nattch: Number(match[6]),
          status: (match[7]?.replace(/\s+/g, " ") ?? "") as z.infer<typeof segmentSchema>["status"],
        });
      }
    }
    return {
      segments,
      ...(total > segments.length && { _summary: { total, shown: segments.length, truncated: true } }),
    };
  },
  fixtures: [
    {
      args: ["-m"],
      input: "\n------ Shared Memory Segments --------\nkey        shmid      owner      perms      bytes      nattch     status      \n0x00488a37 16         postgres   600        56         45                      \n\n",
      expected: { segments: [
        { key: "0x00488a37", shmid: 16, owner: "postgres", perms: "600", bytes: 56, nattch: 45, status: "" },
      ] },
    },
    {
      args: ["--shmems", "--bytes"],
      input: "\n------ Shared Memory Segments --------\nkey        shmid      owner      perms      bytes      nattch     status\n0x00000000 32769      root       660        1048576    2          dest\n0x1234abcd 42         app        600        4096       0          locked\n0x00000000 43         app        600        8192       1          dest locked\n",
      expected: { segments: [
        { key: "0x00000000", shmid: 32769, owner: "root", perms: "660", bytes: 1048576, nattch: 2, status: "dest" },
        { key: "0x1234abcd", shmid: 42, owner: "app", perms: "600", bytes: 4096, nattch: 0, status: "locked" },
        { key: "0x00000000", shmid: 43, owner: "app", perms: "600", bytes: 8192, nattch: 1, status: "dest locked" },
      ] },
    },
    { args: ["-m"], input: "", expected: { segments: [] } },
    {
      args: ["-m"],
      input: "\n------ Shared Memory Segments --------\nkey        shmid      owner      perms      bytes      nattch     status\n\n",
      expected: { segments: [] },
    },
  ],
};
