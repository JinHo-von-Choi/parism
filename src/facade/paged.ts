/**
 * run_paged: 실행한 뒤 표준 출력을 줄 단위 페이지로 나눠 돌려준다. 파싱하지 않는다.
 * 같은 명령의 다음 페이지는 실행 결과를 캐시에서 다시 쓴다.
 *
 * 작성자: 최진호
 * 작성일: 2026-11-12
 */

import type { PrismConfig }                              from "../config/loader.js";
import type { ResponseEnvelope }                         from "../types/envelope.js";
import { execute, truncateUtf8Lines }                    from "../engine/executor.js";
import { checkGuard, GuardError }                        from "../engine/guard.js";
import { buildExecArgs }                                 from "../engine/policy.js";
import type { PageCache }                                from "../engine/page-cache.js";
import { paginateLines }                                 from "../engine/paginator.js";
import type { Semaphore }                                from "../engine/semaphore.js";
import { redact, validatePatterns }                      from "../engine/redactor.js";
import type { RegexFallback }                            from "../engine/regex-engine.js";
import type { OutcomeStats }                             from "../engine/telemetry.js";
import { applyTextFilters }                              from "../engine/pipe-compiler.js";
import { buildGuardErrorEnvelope, buildRejectedEnvelope, resolveRedactPatterns, DEFAULT_MAX_PAGE_SIZE, type RunPagedOptions } from "./envelope.js";
import { attachAvailability, resolveCommand, resolveRealCwd } from "./run-pipeline.js";

export interface PagedDeps {
  config:    PrismConfig;
  execSlots: Semaphore;
  stats:     OutcomeStats | null;
  pageCache: PageCache;
}

type Resolved = Extract<ReturnType<typeof resolveCommand>, { ok: true }>;

/**
 * 실행하거나 캐시에서 가져온다. 페이지를 나누려면 전체 stdout이 필요하므로 실행 단계에서는 max_output_bytes를 적용하지 않는다(0).
 * 실행 단계의 상한은 실행기의 버퍼 상한(10MB, executor.ts)이고, max_output_bytes는 잘라낸 페이지에 적용한다.
 */
async function executeOrCached(deps: PagedDeps, resolved: Resolved, page: number, includeDiff: boolean): Promise<{ envelope: ResponseEnvelope; cache: { hit: boolean; age_ms: number } }> {
  const { cmd, args, cwd, pipeline } = resolved;
  const cacheKey = JSON.stringify([cmd, args, resolveRealCwd(cwd), includeDiff, pipeline?.original ?? null]);
  const cached   = page > 0 ? deps.pageCache.get(cacheKey) : undefined;
  if (cached) return { envelope: cached.envelope, cache: { hit: true, age_ms: Date.now() - cached.createdAt } };
  const executed = await deps.execSlots.run(() => execute(
    cmd, buildExecArgs(cmd, args, deps.config.guard), cwd,
    deps.config.guard.secrets?.env_patterns ?? [], deps.config.guard.timeout_ms, 0, includeDiff,
  ));
  let envelope = attachAvailability(deps.config, { ...executed, args }, cmd, args, cwd);
  if (pipeline) {
    const input = pipeline.stderr === "merge" ? envelope.stdout.raw + envelope.stderr.raw : envelope.stdout.raw;
    envelope = {
      ...envelope,
      stdout: { ...envelope.stdout, raw: await applyTextFilters(input, pipeline.specs) },
      ...(pipeline.stderr === "discard" && { stderr: { ...envelope.stderr, raw: "" } }),
    };
  }
  if (envelope.ok) deps.pageCache.set(cacheKey, { envelope, createdAt: Date.now() });
  /** run_paged는 파싱하지 않으므로 실행 실패만 센다. */
  if (envelope.failure) deps.stats?.record(cmd, "exec", envelope.failure.reason);
  return { envelope, cache: { hit: false, age_ms: 0 } };
}

/** 리댁션을 켰으면 페이지, 표준 오류, 실패 메시지를 가린다 */
async function maskPage(config: PrismConfig, enriched: ResponseEnvelope): Promise<ResponseEnvelope> {
  if (config.guard.secrets?.output_redaction_enabled !== true) return enriched;
  const patterns = validatePatterns(resolveRedactPatterns(config));
  /** 정규식 엔진이 TypeScript 로 되돌아간 사실. 결과에 남긴다. */
  const fallbacks: RegexFallback[] = [];
  const opts = { onFallback: (info: RegexFallback) => { fallbacks.push(info); } };
  const failure = enriched.failure && { ...enriched.failure, message: await redact(enriched.failure.message, patterns, opts) };
  return {
    ...enriched,
    stdout:  { ...enriched.stdout, raw: await redact(enriched.stdout.raw, patterns, opts) },
    stderr:  { ...enriched.stderr, raw: await redact(enriched.stderr.raw, patterns, opts) },
    ...(failure && { failure }),
    ...(fallbacks.length > 0 && { regex_engine: { used: "typescript", fallbacks } }),
  };
}

/**
 * 가드 검사 → 실행 → (파이프 뒤 단계) → 페이지 분할.
 * 명령 문자열의 파이프 뒤 단계는 글자 모드로 적용한 뒤 페이지를 나눈다.
 */
export async function runPaged(deps: PagedDeps, cmdIn: string, opts?: RunPagedOptions): Promise<ResponseEnvelope> {
  const resolved = resolveCommand(cmdIn, opts ?? {});
  if (!resolved.ok) return buildRejectedEnvelope(cmdIn, opts?.args ?? [], opts?.cwd ?? process.cwd(), resolved.failure);
  const { cmd, args, cwd } = resolved;
  const page        = opts?.page ?? 0;
  const requested   = opts?.page_size ?? deps.config.guard.default_page_size;
  const pageSize    = Math.min(requested, deps.config.guard.max_page_size ?? DEFAULT_MAX_PAGE_SIZE);
  try {
    checkGuard(cmd, args, cwd, deps.config);
  } catch (err) {
    if (!(err instanceof GuardError)) throw err;
    deps.stats?.record(cmd, "guard", err.reason);
    return buildGuardErrorEnvelope(cmd, args, cwd, err);
  }

  const { envelope, cache } = await executeOrCached(deps, resolved, page, opts?.includeDiff ?? false);
  const { lines, page_info } = paginateLines(envelope.stdout.raw, page, pageSize);
  page_info.cache = cache;
  if (pageSize < requested) page_info.requested_page_size = requested;
  const maxBytes  = deps.config.guard.max_output_bytes;
  const pagedOut  = truncateUtf8Lines(lines.join("\n") + (lines.length > 0 ? "\n" : ""), maxBytes);
  const pagedErr  = truncateUtf8Lines(envelope.stderr.raw, maxBytes);
  const truncated = envelope.truncated || pagedOut.truncated || pagedErr.truncated ? true : undefined;
  return maskPage(deps.config, {
    ...envelope,
    stdout: { raw: pagedOut.text, parsed: null },
    stderr: { ...envelope.stderr, raw: pagedErr.text },
    page_info,
    ...(truncated && { truncated }),
  });
}
