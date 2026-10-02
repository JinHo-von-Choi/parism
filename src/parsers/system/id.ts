import { UnrecognizedOutputError } from "../registry.js";

export interface IdResult {
  uid:    number;
  user:   string;
  gid:    number;
  group:  string;
  groups: Array<{ id: number; name: string }>;
}

/** 단일 값 모드(-u, -g, -G)의 플래그를 찾는다. 이름 출력(-n)은 지원하지 않는다. */
function singleValueFlag(args: string[]): "u" | "g" | "G" | null {
  const shorts = args.filter(a => /^-[a-zA-Z]+$/.test(a)).join("").replace(/-/g, "");
  if (shorts.includes("n")) return null;
  if (shorts.includes("G")) return "G";
  if (shorts.includes("u")) return "u";
  if (shorts.includes("g")) return "g";
  return null;
}

export function parseId(cmd: string, args: string[], raw: string): IdResult | { uid: number } | { gid: number } | { groups: number[] } {
  const mode = singleValueFlag(args);
  if (mode === "u" && /^\d+\s*$/.test(raw)) return { uid: parseInt(raw, 10) };
  if (mode === "g" && /^\d+\s*$/.test(raw)) return { gid: parseInt(raw, 10) };
  if (mode === "G" && /^\d+(\s+\d+)*\s*$/.test(raw)) {
    return { groups: raw.trim().split(/\s+/).map(n => parseInt(n, 10)) };
  }

  const uidMatch   = raw.match(/uid=(\d+)\(([^)]+)\)/);
  const gidMatch   = raw.match(/gid=(\d+)\(([^)]+)\)/);
  if (!uidMatch || !gidMatch) throw new UnrecognizedOutputError("id output has no uid=/gid= fields");
  const groupsPart = raw.match(/groups=(.+)/);

  const groups: Array<{ id: number; name: string }> = [];
  if (groupsPart) {
    for (const m of groupsPart[1]!.matchAll(/(\d+)\(([^)]+)\)/g)) {
      groups.push({ id: parseInt(m[1]!, 10), name: m[2]! });
    }
  }

  return {
    uid:   parseInt(uidMatch[1]!, 10),
    user:  uidMatch[2]!,
    gid:   parseInt(gidMatch[1]!, 10),
    group: gidMatch[2]!,
    groups,
  };
}
