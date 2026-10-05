import { z }                  from "zod";
import { zodToJsonSchema }      from "zod-to-json-schema";
import { tryParseNativeJson }   from "./json-passthrough.js";
import { countDataLines, isSilentEmpty, type ContractFacts } from "./invariants.js";
import type { RawEvidence } from "../engine/evidence.js";
import { checkFormat, buildHint, collectFlagValues,
         type FlagArity, type PositionalRule, type FormatHint, type HintDraft } from "./format.js";

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
 * 형식 선언(acceptedFlags, acceptedPositionals, subcommands)이 있으면 그 범위 밖의 인자는 unsupported_format이다.
 * supports    -- 선언으로 표현하기 어려운 조건. 선언 검사를 통과한 뒤 추가로 적용한다.
 * subcommands -- 서브커맨드별 계약. 키는 서브커맨드 낱말("log", "pr list")이고 값은 상위 계약에 덧씌운다.
 *                선언하지 않은 서브커맨드는 unsupported_format이다. 빈 문자열 키는 서브커맨드 없는 실행이다.
 */
export interface ParserContract {
  /** 출력 형식을 검증한 플래그와 값 방식. 목록 밖의 플래그는 unsupported_format이다. */
  acceptedFlags?:       Readonly<Record<string, FlagArity>>;
  /** 플래그별 허용 값 패턴 */
  acceptedValues?:      Readonly<Record<string, RegExp>>;
  /** 위치 인자 규칙 */
  acceptedPositionals?: PositionalRule;
  /** 출력 형식을 정하는 플래그. 이 가운데 하나 이상이 있어야 한다. */
  requiredFlags?:       readonly string[];
  /** 함께 쓸 수 없는 플래그. 이 가운데 하나까지만 받는다. */
  exclusiveFlags?:      readonly string[];
  /** `+`로 시작하는 인자를 플래그로 본다(dig +short, lsof +D). */
  plusFlags?:           boolean;
  /** 단일 대시 긴 이름(-name)만 쓰고 단문자 묶음으로 나누지 않는다(find). */
  singleDashLong?:      boolean;
  supports?:    (args: string[]) => boolean;
  /**
   * 형식 밖의 인자일 때 같은 정보를 얻는 인자를 제안한다. 서브커맨드 다음 인자를 받아 그 자리를 대신할 인자를 돌려준다.
   * 제안할 인자가 없으면 null.
   */
  hint?:        (rest: string[]) => HintDraft | null;
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
  /** 데이터 줄이 줄바꿈 대신 NUL로 끝난다(find -print0). 보통 outputFlags로 켠다. */
  nulRecords?:  boolean;
  /** 빈 줄과 공백만 있는 줄도 데이터 줄이다(grep -v나 빈 패턴의 일치 줄). 마지막 종결 문자 뒤의 빈 조각만 뺀다. */
  blankRecords?: boolean;
  /**
   * 출력 모양을 바꾸는 플래그. 키는 플래그 이름이나 "이름=값"이며, 인자에 그 플래그가 있으면
   * 형식 검사가 값의 필드를 유효 계약에 덧씌운다(find -print0의 NUL 구분, wc --total=only의 합계만 있는 출력).
   */
  outputFlags?: Readonly<Record<string, OutputShape>>;
  /** 서브커맨드 앞에 올 수 있는 전역 옵션과 값 여부(git의 -C <경로>) */
  leadingFlags?: Readonly<Record<string, FlagArity>>;
  /** 서브커맨드별 계약 */
  subcommands?:  Readonly<Record<string, ParserContract>>;
}

/** 계약의 출력 모양 필드 */
export type OutputShape = Pick<ParserContract, "headerLines" | "noise" | "rowsKey" | "rowLine" | "rowFields" | "nulRecords" | "blankRecords">;

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

/** 파서 실행 중 예외를 parse_error로 바꾼다. UnrecognizedOutputError는 unrecognized_output이다. */
function failureOf(err: unknown): ParseResult {
  const message = err instanceof Error ? err.message : String(err);
  if (err instanceof UnrecognizedOutputError) return { parsed: null, parse_error: { reason: "unrecognized_output", message } };
  return { parsed: null, parse_error: { reason: "parser_exception", message } };
}

/**
 * 파서 실행 결과. parsed가 null일 때 parse_error가 있으면 파서 예외, 없으면 파서 없음.
 */
export interface ParseResult {
  parsed:      unknown | null;
  parse_error?: {
    reason:  ParseErrorReason;
    message: string;
    /** unsupported_format일 때 같은 정보를 처리 가능한 형식으로 얻는 인자 */
    hint?:   FormatHint;
  };
}

/** native JSON 폴백까지 적용한 결과. native는 parsed가 폴백에서 왔는지 나타낸다. */
export interface FallbackParseResult extends ParseResult {
  native: boolean;
}

/**
 * parse_error.reason 값 목록.
 * unsupported_format  -- 파서가 supports()로 해당 args의 출력 형식을 거부함.
 * unrecognized_output -- 데이터 줄이 있는데 파서가 아무 값도 인식하지 못함.
 */
export type ParseErrorReason = "parser_exception" | "schema_violation" | "unsupported_format" | "unrecognized_output";

/** 격리 실행 파서의 결과. strict 검사를 요청했고 스키마를 어겼으면 위반 메시지가 있다. */
export interface IsolatedParseResult {
  parsed:           unknown;
  schemaViolation?: string;
  /** 실행 단위가 워커 안에서 계약 정규식을 평가해 돌려준 줄 수. 없으면 계산하지 않은 것으로 본다. */
  facts?:           ContractFacts;
}

/**
 * 다른 실행 단위(워커 스레드)에서 실행하는 파서. 외부 ParserPack 격리에 쓴다.
 * contract     -- 실행 단위에서 받은 계약 선언. 함수 필드는 실행 단위를 호출하는 대리 함수다.
 * parse        -- 파서를 실행한다. strictSchemas면 실행 단위가 팩 스키마 검사도 한다.
 *                 파서 예외는 Error로, 인식 실패는 UnrecognizedOutputError로 던진다.
 * withDeadline -- task 안의 실행 단위 호출(계약 함수, parse)이 시간 상한 하나를 함께 쓰게 한다. 없으면 호출마다 따로 센다.
 * close        -- 실행 단위를 끝낸다.
 */
export interface IsolatedParser {
  readonly name:     string;
  readonly contract: ParserContract;
  parse(args: string[], raw: string, ctx: ParseContext | undefined, strictSchemas: boolean): IsolatedParseResult;
  /**
   * 실행 단위 안에서 acceptedValues 를 판정한다. 외부 팩의 정규식은 실행 단위 밖에서 돌릴 수 없다.
   * flagValues는 실행 단위가 정규식을 쓰지 않고 메인 스레드에서 모은 '플래그 이름 -> 값' 이다.
   */
  evalValues?(args: string[], flagValues: Record<string, string>): Record<string, boolean>;
  withDeadline?<T>(task: () => T): T;
  close(): Promise<void>;
}

/** ParserPack에서 계약 선언이 아닌 정의 필드 */
const PACK_DEFINITION_KEYS = ["name", "parse", "schema", "fixtures", "meta"] as const;

/**
 * 파서가 출력에서 값을 얻지 못했거나 줄 해석이 모호해 결과를 만들 수 없을 때 던진다.
 * 레지스트리는 이 예외를 parser_exception이 아닌 unrecognized_output으로 보고한다.
 */
export class UnrecognizedOutputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnrecognizedOutputError";
  }
}

/**
 * 명령어 → 파서 함수의 매핑 테이블.
 * 파서가 없으면 parsed=null. 파서가 예외를 던지면 parsed=null, parse_error 설정.
 */
export class ParserRegistry {
  private readonly parsers = new Map<string, ParserFn>();
  private readonly packs     = new Map<string, ParserPack>();
  private readonly contracts = new Map<string, ParserContract>();
  /** 근거를 만들어 주는 파서. 없는 파서는 근거 표를 비운다. */
  private readonly evidenceParsers = new Map<string, (args: string[], raw: string, ctx: ParseContext | undefined) => RawEvidence>();
  private readonly isolated  = new Map<string, IsolatedParser>();

  register(cmd: string, fn: ParserFn, contract?: ParserContract): void {
    this.dropIsolated(cmd);
    this.parsers.set(cmd, fn);
    if (contract) this.contracts.set(cmd, contract);
    else this.contracts.delete(cmd);
  }

  /**
   * ParserPack을 등록한다. parsers Map에도 어댑터를 등록하여 기존 parse() 경로와 호환.
   */
  registerPack(pack: ParserPack): void {
    this.dropIsolated(pack.name);
    this.packs.set(pack.name, pack);
    this.parsers.set(pack.name, (_cmd, args, raw, ctx) => pack.parse(raw, args, ctx));
    const contract: Record<string, unknown> = { ...pack };
    for (const key of PACK_DEFINITION_KEYS) delete contract[key];
    this.contracts.set(pack.name, contract as ParserContract);
  }

  /**
   * 다른 실행 단위에서 도는 파서를 등록한다. 계약 선언은 parser.contract를 쓰고,
   * strict 스키마 검사는 실행 단위가 수행한다. getPack()으로는 조회되지 않는다.
   */
  registerIsolated(parser: IsolatedParser): void {
    this.dropIsolated(parser.name);
    this.packs.delete(parser.name);
    this.isolated.set(parser.name, parser);
    this.parsers.set(parser.name, (_cmd, args, raw, ctx) => parser.parse(args, raw, ctx, false).parsed);
    this.contracts.set(parser.name, parser.contract);
  }

  /** 격리 실행 파서의 실행 단위를 모두 끝낸다. */
  async close(): Promise<void> {
    const parsers = [...this.isolated.values()];
    this.isolated.clear();
    await Promise.all(parsers.map(p => p.close()));
  }

  /** 같은 이름의 격리 실행 파서를 레지스트리에서 빼고 실행 단위를 끝낸다. */
  private dropIsolated(name: string): void {
    const previous = this.isolated.get(name);
    if (!previous) return;
    this.isolated.delete(name);
    void previous.close();
  }

  /**
   * cmd에 격리 실행 파서가 있으면 task 안의 실행 단위 호출이 시간 상한 하나를 함께 쓰게 한다.
   * parse()는 스스로 이 범위를 쓰며, 그 밖의 계약 조회까지 한 호출로 묶을 때 쓴다.
   */
  withCallDeadline<T>(cmd: string, task: () => T): T {
    const isolated = this.isolated.get(cmd);
    return isolated?.withDeadline ? isolated.withDeadline(task) : task();
  }

  /**
   * 근거를 만들어 주는 파서를 등록한다.
   * 계약으로 형식이 확인된 경우에만 호출된다. 확인되지 않은 형식에는 근거를 지어내지 않고 빈 표를 돌린다.
   */
  registerWithEvidence(cmd: string, fn: (args: string[], raw: string, ctx: ParseContext | undefined) => RawEvidence): void {
    this.evidenceParsers.set(cmd, fn);
  }

  /**
   * 파싱 결과와 함께 필드별 원문 근거를 돌려준다.
   * 근거를 만들 수 없는 파서이거나 계약이 형식을 받지 않는 인자면 근거 표는 비어 있다.
   */
  parseWithEvidence(cmd: string, args: string[], raw: string, ctx?: ParseContext): { parsed: unknown; evidence: RawEvidence } {
    const builder = this.evidenceParsers.get(cmd);
    if (!builder) return { parsed: this.parse(cmd, args, raw, ctx).parsed, evidence: {} };
    const contract = this.contracts.get(cmd);
    if (contract) {
      try {
        if (!checkFormat(contract, args, this.valueVerdicts(cmd, contract, args)).accepted) {
          return { parsed: this.parse(cmd, args, raw, ctx).parsed, evidence: {} };
        }
      } catch {
        return { parsed: this.parse(cmd, args, raw, ctx).parsed, evidence: {} };
      }
    }
    const parsed = this.parse(cmd, args, raw, ctx);
    try {
      return { parsed: parsed.parsed, evidence: builder(args, raw, ctx) };
    } catch {
      /** 근거를 만드는 중 예외가 나면 값은 그대로 두고 근거만 비운다. */
      return { parsed: parsed.parsed, evidence: {} };
    }
  }

  /**
   * 격리 팩의 acceptedValues 판정을 실행 단위에서 받아 온다.
   * 격리 팩이 아니라면 undefined를 돌려 메인 스레드가 정규식을 직접 판정하게 한다.
   */
  private valueVerdicts(cmd: string, contract: ParserContract, args: string[]): Record<string, boolean> | undefined {
    const isolated = this.isolated.get(cmd);
    if (!isolated?.evalValues) return undefined;
    try {
      return this.withCallDeadline(cmd, () => isolated.evalValues!(args, collectFlagValues(contract, args)));
    } catch {
      return {};
    }
  }

  /**
   * cmd와 args에 적용되는 계약을 반환한다. 서브커맨드 계약과 인자의 출력 모양 플래그(outputFlags)를 덧씌운 결과다.
   * 등록된 계약이 없거나 계약 함수(supports)가 예외를 던지면 undefined.
   */
  contractFor(cmd: string, args: string[]): ParserContract | undefined {
    const contract = this.contracts.get(cmd);
    if (!contract) return undefined;
    try {
      return this.withCallDeadline(cmd, () => checkFormat(contract, args, this.valueVerdicts(cmd, contract, args)).contract);
    } catch {
      return undefined;
    }
  }

  /** cmd에 등록된 계약 선언 그대로. 서브커맨드 계약을 덧씌우지 않는다. */
  declaredContract(cmd: string): ParserContract | undefined {
    return this.contracts.get(cmd);
  }

  /** cmd에 파서가 등록돼 있는지 */
  hasParser(cmd: string): boolean {
    return this.parsers.has(cmd);
  }

  /**
   * args가 cmd 계약의 형식 밖이면 같은 정보를 얻는 대체 인자 안내를 돌려준다.
   * 형식 안이거나 계약이 없거나 안내가 없거나 계약 함수(supports, hint)가 예외를 던지면 undefined.
   */
  formatHint(cmd: string, args: string[]): FormatHint | undefined {
    const contract = this.contracts.get(cmd);
    if (!contract) return undefined;
    try {
      return this.withCallDeadline(cmd, () => {
        const verdicts = this.valueVerdicts(cmd, contract, args);
        return checkFormat(contract, args, verdicts).accepted ? undefined : buildHint(contract, args, verdicts);
      });
    } catch {
      return undefined;
    }
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
    return [...this.packs.keys(), ...this.isolated.keys()];
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
    return this.withCallDeadline(cmd, () => this.parseOnce(cmd, args, raw, ctx, strictSchemas));
  }

  /** parse() 본문. 격리 실행 파서의 계약 함수와 parse 호출은 parse()가 연 시간 상한 안에서 돈다. */
  private parseOnce(cmd: string, args: string[], raw: string, ctx: ParseContext | undefined, strictSchemas: boolean): ParseResult {
    const fn = this.parsers.get(cmd);
    if (!fn) return { parsed: null };

    const declared = this.contracts.get(cmd);
    let   format: ReturnType<typeof checkFormat> | undefined;
    let   hint:   FormatHint | undefined;
    try {
      format = declared ? checkFormat(declared, args) : undefined;
      if (declared && format && !format.accepted) hint = buildHint(declared, args);
    } catch (err) {
      return failureOf(err);
    }
    const contract = format?.contract;
    if (format && !format.accepted) {
      return {
        parsed:      null,
        parse_error: {
          reason:  "unsupported_format",
          message: `Output format of '${[cmd, ...args].join(" ")}' is not supported by the '${cmd}' parser: ${format.reason}`,
          ...(hint && { hint }),
        },
      };
    }

    const isolated = this.isolated.get(cmd);
    let parsed:          unknown;
    let schemaViolation: string | undefined;
    let facts:           ContractFacts | undefined;
    try {
      if (isolated) ({ parsed, schemaViolation, facts } = isolated.parse(args, raw, ctx, strictSchemas));
      else parsed = fn(cmd, args, raw, ctx);
    } catch (err) {
      return failureOf(err);
    }

    if (parsed == null) return { parsed: null };

    if (isSilentEmpty(parsed, raw, contract, facts) && tryParseNativeJson(raw) === null) {
      const dataLines = countDataLines(raw, contract, facts);
      return {
        parsed:      null,
        parse_error: { reason: "unrecognized_output", message: `The '${cmd}' parser recognized nothing in ${dataLines} output line(s)` },
      };
    }

    // strict_schemas 활성화 시 ParserPack이 있는 경우에만 검증. 격리 실행 파서는 실행 단위가 검사한 결과를 쓴다.
    if (strictSchemas) {
      const pack = this.packs.get(cmd);
      if (pack) {
        const result = pack.schema.safeParse(parsed);
        if (!result.success) schemaViolation = formatZodError(result.error);
      }
      if (schemaViolation !== undefined) {
        return {
          parsed:      null,
          parse_error: {
            reason:  "schema_violation",
            message: schemaViolation,
          },
        };
      }
    }

    return { parsed };
  }

  /**
   * parse()에 native JSON 폴백을 더한다. 파서 결과가 null이면 stdout 전체를 JSON 문서로 읽어 본다.
   * 폴백이 성공하면 unsupported_format 실패와 안내는 결과에 남기지 않는다.
   */
  parseWithFallback(cmd: string, args: string[], raw: string, ctx?: ParseContext, strictSchemas = false): FallbackParseResult {
    return this.fallback(this.parse(cmd, args, raw, ctx, strictSchemas) as FallbackParseResult, raw);
  }

  /**
   * native JSON 폴백까지 포함한 파싱과 함께 필드 근거를 돌려준다.
   * native JSON 이 값을 냈다면 필드 단위 근거는 "원문 전체"를 가리킨다 — 정체가 아닌 출처임을 밝힌다.
   */
  parseWithFallbackWithEvidence(
    cmd: string, args: string[], raw: string, ctx?: ParseContext, strictSchemas = false,
  ): FallbackParseResult & { evidence: RawEvidence; evidenceReason?: string } {
    const parsed = this.parseWithEvidence(cmd, args, raw, ctx);
    const result = this.fallback(
      this.parse(cmd, args, raw, ctx, strictSchemas) as FallbackParseResult,
      raw,
    );
    /** 파서가 근거를 냈으면 그 표를 쓴다 */
    if (Object.keys(parsed.evidence).length > 0) return { ...result, evidence: parsed.evidence };
    /**
     * native JSON 폴백이 값을 냈다면 필드 단위 구간을 지어낼 수 없다.
     * 근거는 "원문 전체"로만 준다 — 값이 어디서 왔는지는 원문이 답한다.
     */
    if (result.native) {
      return {
        ...result,
        evidence:       { "": [{ source: "stdout", line: 1, start: 0, end: raw.length }] },
        evidenceReason: "native_json_document",
      };
    }
    return { ...result, evidence: {} };
  }

  /** 파싱 결과를 native JSON 폴백까지 확정한 결과로 만든다. */
  private fallback(result: FallbackParseResult, raw: string): FallbackParseResult {
    if (result.parsed != null) return { ...result, native: false };
    const native = tryParseNativeJson(raw);
    if (native === null) return { ...result, native: false };
    const error = result.parse_error?.reason === "unsupported_format" ? undefined : result.parse_error;
    return { parsed: native, ...(error && { parse_error: error }), native: true };
  }
}

/**
 * ParserPack의 Zod 스키마를 JSON Schema 객체로 변환한다.
 * 외부 문서화 및 툴링 용도.
 */
export function exportJsonSchema(pack: ParserPack): object {
  return zodToJsonSchema(pack.schema, pack.name) as object;
}
