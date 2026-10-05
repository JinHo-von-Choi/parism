import type { ParseContext } from "../registry.js";

export interface FindSummary {
  total:     number;
  shown:     number;
  truncated: boolean;
}

export function parseFind(
  cmd: string, args: string[], raw: string, ctx?: ParseContext,
): { paths: string[]; _summary?: FindSummary } {
  const terminator = args.includes("-print0") ? "\0" : "\n";
  /**
   * 줄 구분자로 나눈 뒤에는 남는 것이 경로 전체다. 앞뒤 공백을 다듬으면
   * 이름에 공백이 든 파일("report ", "dir /inner  ")이 다른 경로로 바뀐다.
   * 구분자만 제거하고 값은 그대로 둔다.
   */
  const paths = raw.split(terminator).filter(l => l !== "");

  const maxItems = ctx?.maxItems ?? 0;
  if (maxItems > 0 && paths.length > maxItems) {
    return {
      paths:    paths.slice(0, maxItems),
      _summary: { total: paths.length, shown: maxItems, truncated: true },
    };
  }
  return { paths };
}
