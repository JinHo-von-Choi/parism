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

  /**
   * compact 로 값을 보존할 수 없으면(순환, BigInt, 과도한 깊이) 압축하지 않은 값을 그대로 비교 대상으로 둔다.
   */
  const outcome  = parsed != null ? toCompact(parsed) : null;
  const compact  = outcome === null ? null : outcome.ok ? outcome.value : parsed;

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
