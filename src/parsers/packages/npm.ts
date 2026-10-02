/**
 * npm list / pnpm list / yarn list 출력 파싱.
 * 트리 형식: ├── name@version, ├─┬ name@version, └── name@version, ASCII는 +-- name@version, `-- name@version
 *
 * @author 최진호
 * @date 2026-03-07
 */

import type { ParseContext } from "../registry.js";

export interface NpmDependency {
  name:      string;
  version:   string;
  depth:     number;
  /** 다른 위치에 이미 나온 항목이면 true(deduped 표시) */
  deduped?:  true;
  /** UNMET DEPENDENCY, UNMET OPTIONAL DEPENDENCY, extraneous, invalid 같은 문제 표시 */
  problem?:  string;
}

export interface NpmResult {
  dependencies: NpmDependency[];
}

/** 트리 줄: 들여쓰기 안내선, 가지 표시, 본문. 가지 표시는 UTF-8(├─┬ ├── └─┬ └──)과 ASCII(+-- `--)다. */
const TREE_UTF8  = /^((?:[│ ] )*)[├└]─[─┬] (.+?)\s*$/;
const TREE_ASCII = /^((?:[| ] )*)[+`]-- (.+?)\s*$/;
/** 들여쓰기 안내선이 없는 옛 형식(├── name)과 그 변형 */
const TREE_LOOSE = /^([│\s]*)[├└]──\s+(.+?)\s*$/;

/** 이름과 버전 뒤에 붙는 표시들 */
const TRAILING_NOTE = /\s+(deduped|overridden|extraneous|invalid:?.*|->\s.*|\(.*\))$/;

/** 이름 앞에 붙는 문제 표시 */
const LEADING_PROBLEM = /^(UNMET OPTIONAL DEPENDENCY|UNMET DEPENDENCY|missing:?)\s+/;

/** 본문에서 이름, 버전, 표시를 가른다. */
function splitBody(body: string): Pick<NpmDependency, "name" | "version" | "deduped" | "problem"> {
  let text    = body;
  let problem: string | undefined;
  let deduped = false;

  const leading = LEADING_PROBLEM.exec(text);
  if (leading) {
    problem = leading[1]!.replace(/:$/, "");
    text    = text.slice(leading[0].length);
  }
  for (let m = TRAILING_NOTE.exec(text); m; m = TRAILING_NOTE.exec(text)) {
    const note = m[1]!;
    if (note === "deduped") deduped = true;
    else if (note === "extraneous" || note.startsWith("invalid")) problem ??= note.replace(/:$/, "");
    text = text.slice(0, m.index);
  }

  const split   = /^(@?[^@\s]+)@(\S+)$/.exec(text.trim());
  const name    = split ? split[1]! : text.trim();
  const version = split ? split[2]! : "";
  return { name, version, ...(deduped && { deduped: true as const }), ...(problem && { problem }) };
}

/**
 * npm list / pnpm list 트리 출력을 파싱한다.
 * 깊이는 들여쓰기 한 칸의 너비(첫 중첩 줄의 안내선 길이)로 안내선 길이를 나눠 구한다.
 */
export function parseNpm(
  _cmd: string,
  _args: string[],
  raw: string,
  ctx?: ParseContext,
): NpmResult | { lines: string[] } {
  const lines = raw.split("\n").filter(Boolean);
  const dependencies: NpmDependency[] = [];
  let unit = 0;

  for (const line of lines) {
    const m = TREE_UTF8.exec(line) ?? TREE_ASCII.exec(line) ?? TREE_LOOSE.exec(line);
    if (!m) continue;

    const guide = m[1]!.length;
    if (unit === 0 && guide > 0) unit = guide;
    const item = splitBody(m[2]!.trim());
    if (!item.name) continue;

    dependencies.push({ ...item, depth: unit > 0 ? Math.round(guide / unit) + 1 : 1 });
  }

  if (dependencies.length === 0 && lines.length > 0) return { lines };

  const maxItems = ctx?.maxItems ?? 0;
  const result = maxItems > 0 && dependencies.length > maxItems
    ? dependencies.slice(0, maxItems)
    : dependencies;

  return { dependencies: result };
}
