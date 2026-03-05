import type { PageInfo } from "../types/envelope.js";

export interface PaginateResult {
  lines:     string[];
  page_info: PageInfo;
}

/**
 * raw stdout을 줄 단위로 분할하고 지정 페이지를 반환한다.
 * trailing 빈 줄(마지막 newline으로 인한 빈 문자열)은 제외한다.
 */
export function paginateLines(raw: string, page: number, pageSize: number): PaginateResult {
  const allLines = raw.split("\n");
  // trailing empty string from final newline 제거
  if (allLines.length > 0 && allLines[allLines.length - 1] === "") {
    allLines.pop();
  }

  const totalLines = allLines.length;
  const start      = page * pageSize;
  const end        = start + pageSize;
  const sliced     = allLines.slice(start, end);

  return {
    lines:     sliced,
    page_info: {
      page,
      page_size:   pageSize,
      total_lines: totalLines,
      has_next:    end < totalLines,
    },
  };
}
