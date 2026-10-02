import { UnrecognizedOutputError } from "../registry.js";

export interface CurlResponse {
  status_code: number;
  status_text: string;
  headers:     Record<string, string>;
  /** 같은 이름이 둘 이상인 헤더의 값 목록(set-cookie 등). headers에는 ", "로 이어 붙인 값이 든다. */
  header_values?: Record<string, string[]>;
}

export interface CurlHeaders extends CurlResponse {
  /** 리다이렉트 등으로 앞서 받은 응답(받은 순서). 최종 응답이 위 필드에 담긴다. */
  history?: CurlResponse[];
}

/** 응답 한 덩어리(상태 줄 + 헤더 줄)를 읽는다. 상태 줄이 없으면 null. */
function parseResponse(block: string[]): CurlResponse | null {
  const statusMatch = (block[0] ?? "").trim().match(/^HTTP\/[\d.]+ (\d+)\s*(.*)/);
  if (!statusMatch) return null;

  const values: Record<string, string[]> = {};
  for (const line of block.slice(1)) {
    const m = line.match(/^([^:]+):\s*(.+)/);
    if (!m) continue;
    (values[m[1]!.trim().toLowerCase()] ??= []).push(m[2]!.trim());
  }

  const headers = Object.fromEntries(Object.entries(values).map(([name, list]) => [name, list.join(", ")]));
  const repeated = Object.entries(values).filter(([, list]) => list.length > 1);
  return {
    status_code: parseInt(statusMatch[1]!, 10),
    status_text: statusMatch[2]!,
    headers,
    ...(repeated.length > 0 && { header_values: Object.fromEntries(repeated) }),
  };
}

export function parseCurl(cmd: string, args: string[], raw: string): CurlHeaders | { raw: string } {
  if (!args.some(a => /^-[A-Za-z]*I[A-Za-z]*$/.test(a)) && !args.includes("--head")) {
    return { raw };
  }

  /** 빈 줄로 응답을 나눈다(리다이렉트를 따라가면 응답이 여러 개다). */
  const blocks: string[][] = [];
  let current: string[] = [];
  for (const line of raw.split("\n")) {
    if (line.trim() === "") {
      if (current.length > 0) blocks.push(current);
      current = [];
    } else {
      current.push(line);
    }
  }
  if (current.length > 0) blocks.push(current);

  const responses = blocks.map(parseResponse);
  if (responses.length === 0 || responses.some(r => r === null)) throw new UnrecognizedOutputError("curl output has no HTTP status line");

  const all   = responses as CurlResponse[];
  const final = all[all.length - 1]!;
  return all.length > 1 ? { ...final, history: all.slice(0, -1) } : final;
}
