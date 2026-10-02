/**
 * apt list, apt search 출력 파싱.
 * 형식: package/suite[,suite] version arch [installed,automatic]
 * 설치되지 않은 패키지는 대괄호가 없다. search는 패키지 줄 아래에 들여쓴 설명 줄이 온다.
 *
 * @author 최진호
 * @date 2026-03-07
 */

import type { ParseContext } from "../registry.js";

export interface AptPackage {
  name:    string;
  suite:   string;
  version: string;
  arch:    string;
  status:  string;
  /** apt search의 설명 줄 */
  description?: string;
}

export interface AptResult {
  packages: AptPackage[];
}

const PKG_LINE = /^([^\s/]+\/\S*)\s+(\S+)\s+(\S+)(?:\s+\[([^\]]*)\])?$/;

/** 목록 머리 줄과 검색 진행 문구(영어, 한국어) */
const PROGRESS_LINE = /^(Listing|Sorting|Full Text Search|나열 중|정렬 중|전체 텍스트 검색 중)/;

/**
 * apt list --installed 출력을 파싱한다.
 */
export function parseApt(
  _cmd: string,
  _args: string[],
  raw: string,
  ctx?: ParseContext,
): AptResult | { lines: string[] } {
  const lines = raw.split("\n").filter(Boolean);
  const packages: AptPackage[] = [];

  for (const line of lines) {
    if (PROGRESS_LINE.test(line)) continue;

    if (/^\s/.test(line)) {
      const last = packages[packages.length - 1];
      if (last) last.description = last.description ? `${last.description} ${line.trim()}` : line.trim();
      continue;
    }

    const m = line.match(PKG_LINE);
    if (!m) continue;

    const nameField = m[1] ?? "";
    const slash     = nameField.indexOf("/");
    const namePart  = slash >= 0 ? nameField.slice(0, slash) : nameField;
    const suite     = slash >= 0 ? nameField.slice(slash + 1).split(",").filter(x => x !== "now").join(",") : "";
    const version  = (m[2] ?? "").replace(/^now\s+/, "");

    packages.push({
      name:    namePart.trim(),
      suite:   suite.trim(),
      version: version.trim(),
      arch:    m[3] ?? "",
      status:  m[4] ?? "",
    });
  }

  if (packages.length === 0 && lines.length > 0) return { lines };

  const maxItems = ctx?.maxItems ?? 0;
  const result = maxItems > 0 && packages.length > maxItems
    ? packages.slice(0, maxItems)
    : packages;

  return { packages: result };
}
