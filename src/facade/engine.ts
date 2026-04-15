/**
 * ParismEngine — 라이브러리 모드 진입점.
 * MCP 서버 없이 Node.js 소비자가 Parism 파이프라인을 직접 사용할 수 있도록 한다.
 *
 * 작성자: 최진호
 * 작성일: 2026-04-15
 */

import path                                                                         from "node:path";
import { loadConfig }                                                               from "../config/loader.js";
import type { PrismConfig }                                                         from "../config/loader.js";
import { createRegistry }                                                           from "../parsers/index.js";
import type { ParserRegistry }                                                      from "../parsers/registry.js";
import type { OutputFormat }                                                        from "../parsers/registry.js";
import type { ResponseEnvelope }                                                    from "../types/envelope.js";
import { execute }                                                                  from "../engine/executor.js";
import { checkGuard, GuardError }                                                   from "../engine/guard.js";
import { paginateLines }                                                            from "../engine/paginator.js";
import { redact, validatePatterns, DEFAULT_OUTPUT_REDACT_PATTERNS }                 from "../engine/redactor.js";
import { toCompact }                                                                from "../parsers/compact.js";
import { tryParseNativeJson }                                                       from "../parsers/json-passthrough.js";
import { loadExternalParsers }                                                      from "../cli/auto-loader.js";
import { parismHome }                                                               from "../cli/paths.js";

export interface RunOptions {
  args?:        string[];
  cwd?:         string;
  format?:      "json" | "compact" | "json-no-raw";
  includeDiff?: boolean;
}

export interface RunPagedOptions extends RunOptions {
  page?:      number;
  page_size?: number;
}

/**
 * config에서 effective 리댁션 패턴을 결정한다.
 * - output_patterns가 undefined(미설정) → DEFAULT_OUTPUT_REDACT_PATTERNS 사용
 * - output_patterns가 [] (빈 배열 명시) → 빈 배열 사용 (사용자 의도적 비활성)
 * - output_patterns가 비어있지 않은 배열  → 해당 배열 사용 (defaults와 병합하지 않음)
 */
function resolveRedactPatterns(config: PrismConfig): string[] {
  const patterns = config.guard.secrets?.output_patterns;
  if (patterns === undefined) return DEFAULT_OUTPUT_REDACT_PATTERNS;
  return patterns;
}

/**
 * Guard 차단 시 반환하는 에러 봉투를 생성한다.
 * 직렬화된 출력과의 하위 호환성을 위해 guard_error 필드를 유지한다.
 */
function buildGuardErrorEnvelope(
  cmd: string, args: string[], cwd: string, err: GuardError,
): ResponseEnvelope {
  const envelope: ResponseEnvelope = {
    ok:          false,
    exitCode:    -1,
    cmd,
    args,
    cwd,
    duration_ms: 0,
    stdout:      { raw: "", parsed: null },
    stderr:      { raw: err.message, parsed: null },
    diff:        null,
    guard_error: { reason: err.reason, message: err.message },
    failure:     { kind: "guard" as const, reason: err.reason, message: err.message },
  };
  return envelope;
}

export class ParismEngine {
  constructor(
    private readonly config:   PrismConfig,
    private readonly registry: ParserRegistry,
  ) {}

  /**
   * Guard 검사 → 실행 → JSON 파싱 파이프라인.
   * buildRunResult의 비즈니스 로직을 그대로 이전한다.
   */
  async run(cmd: string, opts?: RunOptions): Promise<ResponseEnvelope> {
    const args        = opts?.args        ?? [];
    const cwd         = opts?.cwd         ?? process.cwd();
    const format      = (opts?.format     ?? "json") as OutputFormat;
    const includeDiff = opts?.includeDiff ?? false;

    try {
      checkGuard(cmd, args, cwd, this.config);
    } catch (err) {
      if (err instanceof GuardError) {
        return buildGuardErrorEnvelope(cmd, args, cwd, err);
      }
      throw err;
    }

    const envelope = await execute(
      cmd, args, cwd,
      this.config.guard.secrets?.env_patterns ?? this.config.guard.env_secret_patterns ?? [],
      this.config.guard.timeout_ms,
      this.config.guard.max_output_bytes,
      includeDiff,
    );

    const parseFormat   = format === "json-no-raw" ? "json" : format;
    const strictSchemas = this.config.parsers?.strict_schemas ?? false;
    const parseResult   = this.registry.parse(cmd, args, envelope.stdout.raw, { maxItems: this.config.guard.max_items, format: parseFormat }, strictSchemas);
    let   parsed       = parseResult.parsed;
    const nativeParsed = parsed == null ? tryParseNativeJson(envelope.stdout.raw) : null;
    if (parsed == null) parsed = nativeParsed;
    const final        = parseFormat === "compact" ? toCompact(parsed) : parsed;
    const stdout       = format === "json-no-raw"
      ? { raw: "", parsed: final, ...(parseResult.parse_error && { parse_error: parseResult.parse_error }) }
      : { ...envelope.stdout, parsed: final, ...(parseResult.parse_error && { parse_error: parseResult.parse_error }) };

    // parse failure 정규화: parser_exception은 failure로 승격, parser_not_found는 ok=true인 정보성 실패
    let parseFailure = envelope.failure;
    if (parseResult.parse_error) {
      parseFailure = { kind: "parse", reason: parseResult.parse_error.reason, message: parseResult.parse_error.message };
    } else if (parseResult.parsed === null && !parseResult.parse_error && nativeParsed === null && envelope.ok) {
      // 파서도 없고 native JSON도 아닐 때: parser_not_found (ok=true 유지 — 정보성 실패)
      parseFailure = { kind: "parse", reason: "parser_not_found", message: `No parser registered for '${cmd}'` };
    }

    let enriched = parseFailure !== undefined
      ? { ...envelope, stdout, failure: parseFailure }
      : { ...envelope, stdout };

    if (this.config.guard.secrets?.output_redaction_enabled === true) {
      const patterns = validatePatterns(resolveRedactPatterns(this.config));
      enriched = {
        ...enriched,
        stdout:  { ...enriched.stdout, raw: redact(enriched.stdout.raw, patterns) },
        stderr:  { ...enriched.stderr, raw: redact(enriched.stderr.raw, patterns) },
      };
    }

    return enriched as ResponseEnvelope;
  }

  /**
   * Guard 검사 → 실행 → 페이지 분할 파이프라인.
   * buildPagedResult의 비즈니스 로직을 그대로 이전한다.
   */
  async runPaged(cmd: string, opts?: RunPagedOptions): Promise<ResponseEnvelope> {
    const args        = opts?.args        ?? [];
    const cwd         = opts?.cwd         ?? process.cwd();
    const includeDiff = opts?.includeDiff ?? false;
    const page        = opts?.page        ?? 0;
    const pageSize    = opts?.page_size   ?? this.config.guard.default_page_size;

    try {
      checkGuard(cmd, args, cwd, this.config);
    } catch (err) {
      if (err instanceof GuardError) {
        return buildGuardErrorEnvelope(cmd, args, cwd, err);
      }
      throw err;
    }

    // 전체 stdout이 필요하므로 max_output_bytes 비활성 (0)
    const envelope               = await execute(
      cmd, args, cwd,
      this.config.guard.secrets?.env_patterns ?? this.config.guard.env_secret_patterns ?? [],
      this.config.guard.timeout_ms,
      0,
      includeDiff,
    );
    const { lines, page_info }   = paginateLines(envelope.stdout.raw, page, pageSize);
    const pagedRaw               = lines.join("\n") + (lines.length > 0 ? "\n" : "");
    let   enriched               = {
      ...envelope,
      stdout:    { raw: pagedRaw, parsed: null as null },
      page_info,
    };

    if (this.config.guard.secrets?.output_redaction_enabled === true) {
      const patterns = validatePatterns(resolveRedactPatterns(this.config));
      enriched = {
        ...enriched,
        stdout:  { ...enriched.stdout, raw: redact(enriched.stdout.raw, patterns) },
        stderr:  { ...enriched.stderr, raw: redact(enriched.stderr.raw, patterns) },
      };
    }

    return enriched as ResponseEnvelope;
  }
}

/**
 * 기본 설정과 파서 레지스트리로 ParismEngine 인스턴스를 생성한다.
 * configPath를 지정하지 않으면 process.cwd()/prism.config.json을 사용한다.
 */
export async function createEngine(opts?: { configPath?: string }): Promise<ParismEngine> {
  const configPath = opts?.configPath ?? path.join(process.cwd(), "prism.config.json");
  const config     = await loadConfig(configPath);
  const registry   = createRegistry();
  const loaded     = await loadExternalParsers(parismHome(), registry);
  if (loaded > 0) {
    process.stderr.write(`[parism] Loaded ${loaded} external parser(s)\n`);
  }
  return new ParismEngine(config, registry);
}
