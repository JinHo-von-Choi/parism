/**
 * 출력 형식.
 * json: 기존 객체 배열 + raw 포함.
 * compact: schema+rows 컬럼 기반.
 * json-no-raw: JSON 출력에서 raw 제외 (토큰 절감, 파서 신뢰 시 사용).
 */
export type OutputFormat = "json" | "compact" | "json-no-raw";

/**
 * 파서가 항목 수를 제한할 때 사용하는 컨텍스트.
 * maxItems=0 이면 무제한.
 */
export interface ParseContext {
  maxItems: number;
  format:   OutputFormat;
}

/**
 * 파서 함수 시그니처.
 */
export type ParserFn = (cmd: string, args: string[], raw: string, ctx?: ParseContext) => unknown;

/**
 * 파서 실행 결과. parsed가 null일 때 parse_error가 있으면 파서 예외, 없으면 파서 없음.
 */
export interface ParseResult {
  parsed:      unknown | null;
  parse_error?: { reason: "parser_exception"; message: string };
}

/**
 * 명령어 → 파서 함수의 매핑 테이블.
 * 파서가 없으면 parsed=null. 파서가 예외를 던지면 parsed=null, parse_error 설정.
 */
export class ParserRegistry {
  private readonly parsers = new Map<string, ParserFn>();

  register(cmd: string, fn: ParserFn): void {
    this.parsers.set(cmd, fn);
  }

  /**
   * cmd에 등록된 파서를 찾아 실행한다.
   * 파서 없음 → { parsed: null }. 파서 예외 → { parsed: null, parse_error }.
   */
  parse(cmd: string, args: string[], raw: string, ctx?: ParseContext): ParseResult {
    const fn = this.parsers.get(cmd);
    if (!fn) return { parsed: null };

    try {
      const parsed = fn(cmd, args, raw, ctx);
      return { parsed: parsed ?? null };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { parsed: null, parse_error: { reason: "parser_exception", message } };
    }
  }
}
