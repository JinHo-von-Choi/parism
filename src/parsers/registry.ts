import { z }             from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";

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
 * Fixture: 파서 검증용 입출력 쌍.
 */
export interface Fixture {
  input:    string;
  args:     string[];
  expected: unknown;
}

/**
 * 파서 팩: 명령어 파서의 완전한 정의.
 * name     -- 대상 명령어 (예: "htop")
 * parse    -- raw stdout + args -> 구조화된 결과 (null이면 파싱 불가)
 * schema   -- Zod 스키마 (출력 형태 정의, 검증/문서 용도)
 * fixtures -- 입출력 쌍 (테스트/검증 용도)
 * meta     -- 선택적 메타 정보
 */
export interface ParserPack {
  name:      string;
  parse:     (raw: string, args: string[], ctx?: ParseContext) => unknown;
  schema:    z.ZodTypeAny;
  fixtures:  Fixture[];
  meta?:     { os?: string[]; version?: string };
}

/**
 * Zod 에러를 간결한 문자열로 변환한다.
 */
function formatZodError(error: z.ZodError): string {
  return error.issues
    .map(i => `${i.path.length > 0 ? i.path.join(".") + ": " : ""}${i.message}`)
    .join("; ");
}

/**
 * 파서 실행 결과. parsed가 null일 때 parse_error가 있으면 파서 예외, 없으면 파서 없음.
 */
export interface ParseResult {
  parsed:      unknown | null;
  parse_error?: {
    reason:  "parser_exception" | "schema_violation";
    message: string;
  };
}

/**
 * 명령어 → 파서 함수의 매핑 테이블.
 * 파서가 없으면 parsed=null. 파서가 예외를 던지면 parsed=null, parse_error 설정.
 */
export class ParserRegistry {
  private readonly parsers = new Map<string, ParserFn>();
  private readonly packs   = new Map<string, ParserPack>();

  register(cmd: string, fn: ParserFn): void {
    this.parsers.set(cmd, fn);
  }

  /**
   * ParserPack을 등록한다. parsers Map에도 어댑터를 등록하여 기존 parse() 경로와 호환.
   */
  registerPack(pack: ParserPack): void {
    this.packs.set(pack.name, pack);
    this.parsers.set(pack.name, (_cmd, args, raw, ctx) => pack.parse(raw, args, ctx));
  }

  /**
   * 등록된 ParserPack을 이름으로 조회한다.
   */
  getPack(name: string): ParserPack | undefined {
    return this.packs.get(name);
  }

  /**
   * 등록된 모든 ParserPack 이름 목록을 반환한다.
   */
  listPacks(): string[] {
    return [...this.packs.keys()];
  }

  /**
   * cmd에 등록된 파서를 찾아 실행한다.
   * strictSchemas=true이고 cmd에 ParserPack이 등록된 경우, 파서 출력을 schema로 검증한다.
   * 파서 없음 → { parsed: null }. 파서 예외 → { parsed: null, parse_error }.
   * schema 검증 실패 → { parsed: null, parse_error: { reason: "schema_violation" } }.
   */
  parse(cmd: string, args: string[], raw: string, ctx?: ParseContext, strictSchemas = false): ParseResult {
    const fn = this.parsers.get(cmd);
    if (!fn) return { parsed: null };

    let parsed: unknown;
    try {
      parsed = fn(cmd, args, raw, ctx);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { parsed: null, parse_error: { reason: "parser_exception", message } };
    }

    if (parsed == null) return { parsed: null };

    // strict_schemas 활성화 시 ParserPack이 있는 경우에만 검증
    if (strictSchemas) {
      const pack = this.packs.get(cmd);
      if (pack) {
        const result = pack.schema.safeParse(parsed);
        if (!result.success) {
          return {
            parsed:      null,
            parse_error: {
              reason:  "schema_violation",
              message: formatZodError(result.error),
            },
          };
        }
      }
    }

    return { parsed };
  }
}

/**
 * ParserPack의 Zod 스키마를 JSON Schema 객체로 변환한다.
 * 외부 문서화 및 툴링 용도.
 */
export function exportJsonSchema(pack: ParserPack): object {
  return zodToJsonSchema(pack.schema, pack.name) as object;
}
