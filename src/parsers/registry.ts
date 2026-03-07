/**
 * 출력 형식. json=기존 객체 배열, compact=schema+rows 컬럼 기반.
 */
export type OutputFormat = "json" | "compact";

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
 * 명령어 → 파서 함수의 매핑 테이블.
 * 파서가 없거나 실패하면 null을 반환한다 (graceful degradation).
 */
export class ParserRegistry {
  private readonly parsers = new Map<string, ParserFn>();

  register(cmd: string, fn: ParserFn): void {
    this.parsers.set(cmd, fn);
  }

  /**
   * cmd에 등록된 파서를 찾아 실행한다.
   * 파서 없음 또는 예외 → null 반환.
   */
  parse(cmd: string, args: string[], raw: string, ctx?: ParseContext): unknown | null {
    const fn = this.parsers.get(cmd);
    if (!fn) return null;

    try {
      return fn(cmd, args, raw, ctx);
    } catch {
      return null;
    }
  }
}
