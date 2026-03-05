export interface IdResult {
  uid:    number;
  user:   string;
  gid:    number;
  group:  string;
  groups: Array<{ id: number; name: string }>;
}

export function parseId(cmd: string, args: string[], raw: string): IdResult {
  const uidMatch   = raw.match(/uid=(\d+)\(([^)]+)\)/);
  const gidMatch   = raw.match(/gid=(\d+)\(([^)]+)\)/);
  const groupsPart = raw.match(/groups=(.+)/);

  const groups: Array<{ id: number; name: string }> = [];
  if (groupsPart) {
    for (const m of groupsPart[1]!.matchAll(/(\d+)\(([^)]+)\)/g)) {
      groups.push({ id: parseInt(m[1]!, 10), name: m[2]! });
    }
  }

  return {
    uid:   uidMatch ? parseInt(uidMatch[1]!, 10) : 0,
    user:  uidMatch ? uidMatch[2]! : "",
    gid:   gidMatch ? parseInt(gidMatch[1]!, 10) : 0,
    group: gidMatch ? gidMatch[2]! : "",
    groups,
  };
}
