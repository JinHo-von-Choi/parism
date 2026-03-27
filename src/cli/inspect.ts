import type { ParserRegistry } from "../parsers/registry.js";
import { toCompact }           from "../parsers/compact.js";

export interface InspectResult {
  raw:     string;
  parsed:  unknown | null;
  compact: unknown | null;
  tokens: {
    raw:     number;
    parsed:  number;
    compact: number;
  };
}

/**
 * 토큰 수 추정. Math.ceil(text.length / 4) -- 간단한 근사.
 */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * 명령어 raw 출력을 파싱/컴팩트 변환하고, 각 형식의 토큰 수를 추정한다.
 */
export function inspectOutput(
  cmd:      string,
  args:     string[],
  raw:      string,
  registry: ParserRegistry,
): InspectResult {
  const { parsed } = registry.parse(cmd, args, raw);

  const compact = parsed != null ? toCompact(parsed) : null;

  const rawTokens     = estimateTokens(raw);
  const parsedTokens  = parsed != null ? estimateTokens(JSON.stringify(parsed, null, 2)) : 0;
  const compactTokens = compact != null ? estimateTokens(JSON.stringify(compact, null, 2)) : 0;

  return {
    raw,
    parsed,
    compact,
    tokens: {
      raw:     rawTokens,
      parsed:  parsedTokens,
      compact: compactTokens,
    },
  };
}
