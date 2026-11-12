/**
 * ParismEngine — 라이브러리 모드 진입점.
 * MCP 서버 없이 Node.js 소비자가 Parism 파이프라인을 직접 사용할 수 있도록 한다.
 *
 * 이 클래스는 세션 상태(실행 슬롯, 결과 보관함, 태스크, 서비스, 영수증)를 가지고, 일은 모듈에 맡긴다.
 *
 *   run-pipeline.ts  run 한 번의 다섯 단계
 *   results.ts       보관 결과 재질의·이어 읽기·비교·근거
 *   paged.ts         run_paged
 *   describe.ts      describe
 *
 * 작성자: 최진호
 * 작성일: 2026-04-15
 */

import path                                                     from "node:path";
import { loadConfig, loadConfigMultiLayer, DEFAULT_RECEIPTS, DEFAULT_RESULTS, DEFAULT_STATS, DEFAULT_TASKS } from "../config/loader.js";
import type { PrismConfig }                                     from "../config/loader.js";
import { createRegistry }                                       from "../parsers/index.js";
import type { ParserRegistry }                                  from "../parsers/registry.js";
import type { ResponseEnvelope }                                from "../types/envelope.js";
import { TaskManager, DEFAULT_TASK_RETENTION, type TaskLookup } from "../engine/tasks.js";
import { ServiceManager, type ServiceOptions }                  from "../engine/services.js";
import { ReceiptStore, loadSigningKey }                         from "../engine/receipts.js";
import { machineFormatArgs, progressFor }                       from "../parsers/devloop/index.js";
import { checkGuard, GuardError }                               from "../engine/guard.js";
import { PageCache }                                            from "../engine/page-cache.js";
import { Semaphore }                                            from "../engine/semaphore.js";
import { OutcomeStats }                                         from "../engine/telemetry.js";
import { ResultStore, DEFAULT_RESULT_STORE_LIMITS }             from "../engine/result-store.js";
import { StatsLog }                                             from "../engine/stats-log.js";
import { parsePipeline }                                        from "../engine/pipe-compiler.js";
import { loadExternalParsers, externalParserOptions }           from "../cli/auto-loader.js";
import { parismHome }                                           from "../cli/paths.js";
import type { CompareOptions, CompareResult }                   from "../engine/compare/index.js";
import { buildGuardErrorEnvelope, buildRejectedEnvelope, concurrencyLimit,
         type ExplainResult, type FetchResult, type QueryResult, type RunOptions,
         type RunPagedOptions, type TaskStartResult }           from "./envelope.js";
import type { PageStore }                                       from "./run-budget.js";
import { runPipeline, resolveCommand, type RunControl, type RunDeps } from "./run-pipeline.js";
import { compareStored, explainResult, fetchResult, queryResult } from "./results.js";
import { runPaged }                                             from "./paged.js";
import { describeEnvironment, type DescribeResult, type DryRunResult } from "./describe.js";
import type { CommandDescription, CommandDescriptionFailure }   from "./capabilities.js";

/**
 * 공개 타입을 이 자리에서 다시 내보낸다. 이 파일은 패키지의 `@nerdvana/parism/engine` 서브패스 export다.
 * 타입의 실체는 다른 모듈에 있지만 import 경로는 바꾸지 않는다.
 */
export type {
  ExecOptions, ExplainResult, FetchResult, QueryResult, RunOptions, RunPagedOptions, TaskStartResult,
} from "./envelope.js";
export type { TaskLookup, TaskSnapshot }                      from "../engine/tasks.js";
export type { Receipt }                                        from "../engine/receipts.js";
export type { DescribeResult, DryRunResult }                   from "./describe.js";
export type { CommandDescription, CommandDescriptionFailure }  from "./capabilities.js";
export type { ServiceOptions }                                 from "../engine/services.js";

const PAGE_CACHE_TTL_MS      = 30_000;
const PAGE_CACHE_MAX_ENTRIES = 16;
const PAGE_CACHE_MAX_BYTES   = 32 * 1024 * 1024;

export class ParismEngine {
  private readonly pageCache = new PageCache(PAGE_CACHE_TTL_MS, PAGE_CACHE_MAX_ENTRIES, PAGE_CACHE_MAX_BYTES);
  /** 자식 프로세스 동시 실행 상한. 넘는 요청은 자리가 날 때까지 대기한다. */
  private readonly execSlots: Semaphore;
  /** 텔레메트리를 켰을 때만 있는 명령별 결과 카운터 */
  private readonly stats:     OutcomeStats | null;
  /** 보관한 결과. 메모리에만 있고 디스크에 남지 않는다. */
  private readonly results:   ResultStore;
  /** 예산 안에 잘라 낸 결과의 원본 행. 이어 읽기가 재실행 없이 되게 한다. */
  private readonly pages:     PageStore = new Map();
  /** 장기 실행 태스크. 일반 실행 슬롯과 따로 센다. */
  private readonly tasks:     TaskManager;
  /** 준비될 때까지 기다린 뒤 계속 실행하는 서비스 */
  private readonly services:  ServiceManager;
  /** 영수증 보관소. receipts.enabled가 아니면 null이다. */
  private readonly receipts:  ReceiptStore | null;
  /** 영수증 서명 키. 쓸 수 없으면 undefined다. */
  private readonly receiptKey: Buffer | undefined;
  /** 사용 통계 기록. stats.enabled가 아니면 null이다. */
  private readonly statsLog:  StatsLog | null;

  constructor(
    private readonly config:   PrismConfig,
    private readonly registry: ParserRegistry,
  ) {
    this.execSlots = new Semaphore(concurrencyLimit(config.guard.max_concurrency));
    this.stats     = config.telemetry?.enabled === true ? new OutcomeStats(config.guard.allowed_commands) : null;
    const results  = config.results ?? DEFAULT_RESULTS;
    this.results   = new ResultStore({ ...DEFAULT_RESULT_STORE_LIMITS, maxEntries: results.max_entries, ttlMs: results.ttl_ms });
    const tasks    = config.tasks ?? DEFAULT_TASKS;
    this.tasks     = new TaskManager({ ...DEFAULT_TASK_RETENTION, maxConcurrency: tasks.max_concurrency });
    this.services  = new ServiceManager({
      maxConcurrency:  tasks.max_concurrency,
      allowPersistent: tasks.allow_persistent_services === true,
      logDir:          path.join(parismHome(), "services"),
    });

    const receipts = config.receipts ?? DEFAULT_RECEIPTS;
    this.receipts  = receipts.enabled
      ? new ReceiptStore(path.join(parismHome(), "receipts"), { maxEntries: receipts.max_entries, maxAgeDays: receipts.max_age_days })
      : null;
    const signing  = receipts.enabled
      ? loadSigningKey(receipts.key_file, config.guard.allowed_paths, path.join(parismHome(), "receipts", "receipts.key"))
      : {};
    if (signing.warning) process.stderr.write(`[parism] WARNING: ${signing.warning}\n`);
    this.receiptKey = signing.key;
    const stats     = config.stats ?? DEFAULT_STATS;
    this.statsLog   = stats.enabled ? new StatsLog(path.join(parismHome(), "stats"), stats.max_entries) : null;
  }

  private get deps(): RunDeps {
    return {
      config: this.config, registry: this.registry, execSlots: this.execSlots, stats: this.stats,
      results: this.results, pages: this.pages, receipts: this.receipts,
      ...(this.receiptKey && { receiptKey: this.receiptKey }), statsLog: this.statsLog,
    };
  }

  /** 명령 해석 → 가드 → 실행 → 파싱 → 투영 → 마스킹 → 재검토 → 영수증·예산 */
  run(cmd: string, opts?: RunOptions, control?: RunControl): Promise<ResponseEnvelope> {
    return runPipeline(this.deps, cmd, opts, control);
  }

  /** 보관된 결과에 다른 조건을 걸어 돌려준다. 명령을 다시 실행하지 않는다. */
  queryResult(resultId: string, query: Record<string, unknown>): QueryResult {
    const result = queryResult(this.deps, resultId, query);
    this.statsLog?.record({ kind: "query", hit: result.ok });
    return result;
  }

  /**
   * 명령을 태스크로 시작한다. 가드를 통과하고 태스크 슬롯이 있으면 식별자를 바로 돌려주고,
   * 명령은 서버 안에서 계속 실행된다. 시작하지 못하면 거절 봉투를 돌려준다.
   */
  startTask(cmdIn: string, opts?: RunOptions): TaskStartResult {
    const resolved = resolveCommand(cmdIn, opts ?? {});
    if (!resolved.ok) {
      return { started: false, envelope: buildRejectedEnvelope(cmdIn, opts?.args ?? [], opts?.cwd ?? process.cwd(), resolved.failure) };
    }
    const { cmd, cwd } = resolved;
    if (opts?.contract_version !== "next") {
      return { started: false, envelope: buildRejectedEnvelope(cmd, resolved.args, cwd, {
        kind: "config", reason: "requires_contract_next",
        message: "mode: \"task\" needs contract_version: \"next\"; the command was not run",
      }) };
    }
    const args = (opts.machine_format === true ? machineFormatArgs(cmd, resolved.args)?.args : undefined) ?? resolved.args;
    try {
      checkGuard(cmd, args, cwd, this.config);
    } catch (err) {
      if (!(err instanceof GuardError)) throw err;
      this.stats?.record(cmd, "guard", err.reason);
      this.statsLog?.record({ kind: "guard_block", cmd, outcome: err.reason });
      return { started: false, envelope: buildGuardErrorEnvelope(cmd, args, cwd, err) };
    }
    const timeoutMs = (this.config.tasks ?? DEFAULT_TASKS).timeout_ms;
    /** 태스크 안의 run은 같은 입력을 다시 해석한다. 해석은 결정적이라 같은 명령이 된다. */
    const started   = this.tasks.start({ cmd, args, cwd }, exec => this.run(cmdIn, opts, { timeoutMs, exec }), progressFor(cmd, args));
    if (!started.ok) {
      return { started: false, envelope: buildRejectedEnvelope(cmd, args, cwd, { kind: "exec", reason: started.reason, message: started.message }) };
    }
    return { started: true, task: started.task };
  }

  /**
   * 서비스를 띄운다. ready_pattern이 출력에 나오거나 ready_port가 열릴 때까지(최대 30초) 기다린 뒤 돌려준다.
   * 서비스는 lease_ms(최대 5분)가 지나거나 서버가 끝나면 프로세스 그룹째 종료한다.
   */
  async startService(cmdIn: string, opts: RunOptions & ServiceOptions): Promise<TaskStartResult> {
    const resolved = resolveCommand(cmdIn, opts);
    if (!resolved.ok) {
      return { started: false, envelope: buildRejectedEnvelope(cmdIn, opts.args ?? [], opts.cwd ?? process.cwd(), resolved.failure) };
    }
    const { cmd, args, cwd } = resolved;
    if (resolved.pipeline) {
      return { started: false, envelope: buildRejectedEnvelope(cmd, args, cwd, {
        kind: "config", reason: "unsupported_shell_operator", operator: "|",
        message: "a service cannot have pipe stages; start the server alone and query it with a separate run",
      }) };
    }
    try {
      checkGuard(cmd, args, cwd, this.config);
    } catch (err) {
      if (!(err instanceof GuardError)) throw err;
      this.statsLog?.record({ kind: "guard_block", cmd, outcome: err.reason });
      return { started: false, envelope: buildGuardErrorEnvelope(cmd, args, cwd, err) };
    }
    const started = await this.services.start({ cmd, args, cwd }, this.config, opts);
    if (!started.ok) {
      return { started: false, envelope: buildRejectedEnvelope(cmd, args, cwd, { kind: "config", reason: started.reason, message: started.message }) };
    }
    return { started: true, task: started.task };
  }

  /** 태스크나 서비스의 현재 상태. 끝났으면 결과 봉투가 함께 온다. */
  taskStatus(taskId: string): TaskLookup {
    return this.services.has(taskId) ? this.services.status(taskId) : this.tasks.status(taskId);
  }

  /** 끝나거나 새 실패가 나오거나 waitMs가 지날 때까지 기다린 뒤 상태를 돌려준다. */
  taskWait(taskId: string, waitMs: number): Promise<TaskLookup> {
    return this.services.has(taskId) ? this.services.wait(taskId, waitMs) : this.tasks.wait(taskId, waitMs);
  }

  /** 태스크나 서비스 하나를 끝낸다. 다른 실행에는 영향을 주지 않는다. */
  taskCancel(taskId: string): TaskLookup {
    return this.services.has(taskId) ? this.services.cancel(taskId) : this.tasks.cancel(taskId);
  }

  /** 실행 중인 태스크와 서비스를 모두 끝낸다. 서버를 끝낼 때 부른다. persist로 띄운 서비스는 lease까지 남는다. */
  cancelAllTasks(): void {
    this.tasks.cancelAll();
    this.services.stopAll();
  }

  /** 저장된 결과의 다음 페이지를 재실행 없이 돌려준다. */
  fetchResult(resultId: string, cursor: string, budget?: { max_tokens: number; tokenizer?: string }): FetchResult {
    return fetchResult(this.deps, resultId, cursor, budget);
  }

  /** 이미 보관된 두 결과의 의미 diff. 새 명령을 실행하지 않는다. */
  compare(baseId: string, currentId: string, options: CompareOptions & { strict?: boolean } = {}): CompareResult {
    return compareStored(this.deps, baseId, currentId, options);
  }

  /** 보관된 결과의 값 하나가 원문 어디서 왔는지 돌려준다. 재실행하지 않는다. */
  explainResult(resultId: string, pointer: string): ExplainResult {
    return explainResult(this.deps, resultId, pointer);
  }

  /** 현재 환경 정보. cmd를 주면 그 명령의 유효 정책, 파서 형식, 부작용 등급, 예시만 돌려준다. */
  describe(): DescribeResult;
  describe(cmd: string): CommandDescription | CommandDescriptionFailure;
  describe(cmd?: string): DescribeResult | CommandDescription | CommandDescriptionFailure {
    return cmd === undefined ? describeEnvironment(this.deps) : describeEnvironment(this.deps, cmd);
  }

  /** 실제 실행 없이 가드 통과 여부만 확인한다. 명령 문자열은 렉서와 파이프 단계 해석까지 확인한다. */
  dryRun(cmdIn: string, args: string[] = [], cwd: string = process.cwd(), command?: string): DryRunResult {
    const resolved = resolveCommand(cmdIn, { args, cwd, ...(command !== undefined && { command }) });
    if (!resolved.ok) return { would_pass: false, reason: resolved.failure.reason, message: resolved.failure.message };
    if (resolved.pipeline) {
      const stages = parsePipeline(resolved.pipeline.stages);
      if (!stages.ok) return { would_pass: false, reason: "unsupported_pipe_stage", message: stages.message };
    }
    const parsedAs = resolved.cmd !== cmdIn || command !== undefined ? { resolved: { cmd: resolved.cmd, args: resolved.args, cwd: resolved.cwd } } : {};
    try {
      checkGuard(resolved.cmd, resolved.args, resolved.cwd, this.config);
      return { would_pass: true, ...parsedAs };
    } catch (err) {
      if (err instanceof GuardError) return { would_pass: false, reason: err.reason, message: err.message, ...parsedAs };
      return { would_pass: false, reason: "unknown", message: err instanceof Error ? err.message : String(err) };
    }
  }

  /** 가드 검사 → 실행 → 페이지 분할. 파싱하지 않는다. */
  runPaged(cmd: string, opts?: RunPagedOptions): Promise<ResponseEnvelope> {
    return runPaged({ config: this.config, execSlots: this.execSlots, stats: this.stats, pageCache: this.pageCache }, cmd, opts);
  }
}

/**
 * 기본 설정과 파서 레지스트리로 ParismEngine 인스턴스를 생성한다.
 * 다층 설정(global/project/env)을 자동으로 로드한다.
 */
export async function createEngine(opts?: { configPath?: string }): Promise<ParismEngine> {
  const config   = opts?.configPath ? await loadConfig(opts.configPath) : await loadConfigMultiLayer();
  const registry = createRegistry();
  const loaded   = await loadExternalParsers(parismHome(), registry, externalParserOptions(config.parsers));
  if (loaded > 0) process.stderr.write(`[parism] Loaded ${loaded} external parser(s)\n`);
  return new ParismEngine(config, registry);
}
