import { z }                  from "zod";
import { zodToJsonSchema }      from "zod-to-json-schema";
import { tryParseNativeJson }   from "./json-passthrough.js";
import { countDataLines, isSilentEmpty } from "./invariants.js";
import { resolveContract }      from "./format.js";

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
 * 파서가 처리할 수 있는 입력 범위와 출력 모양의 선언.
 * supports    -- args 기준으로 출력 형식을 처리할 수 있는지 판정. false면 파서를 실행하지 않는다.
 * subcommands -- 서브커맨드별 계약. 키는 서브커맨드 낱말("log", "pr list")이고 값은 상위 계약에 덧씌운다.
 */
export interface ParserContract {
  supports?:    (args: string[]) => boolean;
  /** 데이터가 아닌 머리 줄 수(공백 줄 제외). 머리만 있는 출력은 정상적인 빈 결과로 본다. */
  headerLines?: number;
  /** 데이터가 아닌 줄(합계, 범례, 안내 문구) 패턴. */
  noise?:       RegExp;
  /** 데이터 줄 하나당 행 하나를 담는 결과 배열의 키(ls의 "entries"). 불변식 검사가 행 수를 대조한다. */
  rowsKey?:     string;
  /** 데이터 줄 가운데 행이 되는 줄의 패턴. 없으면 모든 데이터 줄이 행이다. */
  rowLine?:     RegExp;
  /** 행 객체가 가질 수 있는 필드 이름 목록 */
  rowFields?:   readonly string[];
  /** 서브커맨드 앞에 올 수 있는 전역 옵션과 값 여부(git의 -C <경로>) */
  leadingFlags?: Readonly<Record<string, "bool" | "value">>;
  /** 서브커맨드별 계약 */
  subcommands?:  Readonly<Record<string, ParserContract>>;
}

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
 * 그 밖의 필드는 ParserContract 선언이다.
 */
export interface ParserPack extends ParserContract {
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
    reason:  ParseErrorReason;
    message: string;
  };
}

/**
 * parse_error.reason 값 목록.
 * unsupported_format  -- 파서가 supports()로 해당 args의 출력 형식을 거부함.
 * unrecognized_output -- 데이터 줄이 있는데 파서가 아무 값도 인식하지 못함.
 */
export type ParseErrorReason = "parser_exception" | "schema_violation" | "unsupported_format" | "unrecognized_output";

/** ParserPack에서 계약 선언이 아닌 정의 필드 */
const PACK_DEFINITION_KEYS = ["name", "parse", "schema", "fixtures", "meta"] as const;

/**
 * 명령어 → 파서 함수의 매핑 테이블.
 * 파서가 없으면 parsed=null. 파서가 예외를 던지면 parsed=null, parse_error 설정.
 */
export class ParserRegistry {
  private readonly parsers = new Map<string, ParserFn>();
  private readonly packs     = new Map<string, ParserPack>();
  private readonly contracts = new Map<string, ParserContract>();

  register(cmd: string, fn: ParserFn, contract?: ParserContract): void {
    this.parsers.set(cmd, fn);
    if (contract) this.contracts.set(cmd, contract);
    else this.contracts.delete(cmd);
  }

  /**
   * ParserPack을 등록한다. parsers Map에도 어댑터를 등록하여 기존 parse() 경로와 호환.
   */
  registerPack(pack: ParserPack): void {
    this.packs.set(pack.name, pack);
    this.parsers.set(pack.name, (_cmd, args, raw, ctx) => pack.parse(raw, args, ctx));
    const contract: Record<string, unknown> = { ...pack };
    for (const key of PACK_DEFINITION_KEYS) delete contract[key];
    this.contracts.set(pack.name, contract as ParserContract);
  }

  /**
   * cmd와 args에 적용되는 계약을 반환한다. 서브커맨드 계약이 있으면 상위 계약에 덧씌운 결과다.
   * 등록된 계약이 없으면 undefined.
   */
  contractFor(cmd: string, args: string[]): ParserContract | undefined {
    const contract = this.contracts.get(cmd);
    return contract ? resolveContract(contract, args).contract : undefined;
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
   * register()로 등록된 모든 명령어 이름 목록을 반환한다.
   * registerPack()으로 등록된 명령어도 parsers Map에 어댑터가 함께 등록되므로 포함된다.
   */
  listCommands(): string[] {
    return [...this.parsers.keys()];
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

    const contract = this.contractFor(cmd, args);
    if (contract?.supports && !contract.supports(args)) {
      return {
        parsed:      null,
        parse_error: { reason: "unsupported_format", message: `Output format of '${[cmd, ...args].join(" ")}' is not supported by the '${cmd}' parser` },
      };
    }

    let parsed: unknown;
    try {
      parsed = fn(cmd, args, raw, ctx);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { parsed: null, parse_error: { reason: "parser_exception", message } };
    }

    if (parsed == null) return { parsed: null };

    if (isSilentEmpty(parsed, raw, contract) && tryParseNativeJson(raw) === null) {
      const dataLines = countDataLines(raw, contract);
      return {
        parsed:      null,
        parse_error: { reason: "unrecognized_output", message: `The '${cmd}' parser recognized nothing in ${dataLines} output line(s)` },
      };
    }

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
