export interface CompactArray {
  schema: string[];
  rows:   unknown[][];
}

export function toCompact(parsed: unknown): unknown {
  if (parsed == null) return null;
  if (typeof parsed !== "object" || Array.isArray(parsed)) return parsed;

  const obj    = parsed as Record<string, unknown>;
  const result: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(obj)) {
    if (!Array.isArray(value) || value.length === 0) {
      if (Array.isArray(value) && value.length === 0) {
        result[key] = { schema: [], rows: [] };
      } else {
        result[key] = value;
      }
      continue;
    }

    if (typeof value[0] !== "object" || value[0] === null) {
      result[key] = value;
      continue;
    }

    const schema = Object.keys(value[0] as Record<string, unknown>);
    const rows   = value.map((item) => {
      const rec = item as Record<string, unknown>;
      return schema.map((k) => rec[k]);
    });
    result[key] = { schema, rows };
  }

  return result;
}
