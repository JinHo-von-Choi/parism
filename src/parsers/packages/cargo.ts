/**
 * cargo tree 출력 파싱.
 * 줄 형식: [가지] name vX.Y.Z [(proc-macro)] [(경로 또는 소스)] [(*)]
 *
 * @author 최진호
 * @date 2026-03-07
 */

import type { ParseContext } from "../registry.js";

export interface CargoCrate {
  name:        string;
  version:     string;
  /** 로컬 경로 의존성의 디렉터리 */
  path?:       string;
  /** git, 레지스트리 같은 경로가 아닌 소스 표기 */
  source?:     string;
  /** 트리에서의 깊이. 루트는 0. --prefix none이면 알 수 없어 없다. */
  depth?:      number;
  /** 이미 위에 나온 항목이라 하위를 생략했음을 뜻하는 (*) 표시 */
  deduped?:    true;
  proc_macro?: true;
}

export interface CargoResult {
  crates: CargoCrate[];
}

/** 가지 안내선(UTF-8: │ , ASCII: |  ) 뒤의 가지 표시(├── └── |-- `--)와 본문 */
const TREE_LINE = /^((?:(?:│|\|)\s{3}|\s{4})*)(?:(?:├|└)──\s|(?:\||`)--\s)?(\S+) v(\S+)(.*)$/;

/** 이름 뒤 괄호 표시를 하나씩 읽는다. */
const NOTE = /\(([^()]*)\)/g;

/** 경로 의존성 표기 */
const IS_PATH = /^(?:\/|\.\.?\/|[A-Za-z]:[\\/])/;

/**
 * cargo tree 출력을 파싱한다.
 * 깊이는 안내선 길이를 4로 나눈 값에 가지 표시 한 칸을 더해 구한다. --prefix none에서는 깊이를 담지 않는다.
 */
export function parseCargo(
  _cmd: string,
  args: string[],
  raw: string,
  ctx?: ParseContext,
): CargoResult | { lines: string[] } {
  const lines = raw.split("\n").filter(Boolean);
  const crates: CargoCrate[] = [];
  const flat  = args.some((a, i) => a === "--prefix=none" || (a === "--prefix" && args[i + 1] === "none"));

  for (const line of lines) {
    const m = TREE_LINE.exec(line);
    if (!m) continue;

    const guide      = m[1]!.length;
    const hasBranch  = line.length > guide && /^(?:├|└|\||`)/.test(line.slice(guide));
    const notes      = [...(m[4] ?? "").matchAll(NOTE)].map(n => n[1]!);

    const path   = notes.find(n => IS_PATH.test(n));
    const source = notes.find(n => n !== "*" && n !== "proc-macro" && !IS_PATH.test(n));

    crates.push({
      name:    m[2]!,
      version: `v${m[3]!}`,
      ...(path !== undefined && { path }),
      ...(source !== undefined && { source }),
      ...(!flat && { depth: guide / 4 + (hasBranch ? 1 : 0) }),
      ...(notes.includes("*") && { deduped: true as const }),
      ...(notes.includes("proc-macro") && { proc_macro: true as const }),
    });
  }

  if (crates.length === 0 && lines.length > 0) return { lines };

  const maxItems = ctx?.maxItems ?? 0;
  const result = maxItems > 0 && crates.length > maxItems
    ? crates.slice(0, maxItems)
    : crates;

  return { crates: result };
}
