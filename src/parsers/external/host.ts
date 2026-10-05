/**
 * 외부 ParserPack 격리 실행.
 * 팩마다 워커 스레드 하나를 두고 팩 모듈은 그 워커에서만 읽는다. 메인 스레드는 직렬화한 계약 선언만 받는다.
 * 레지스트리의 parse API는 동기라서, 메인 스레드는 요청을 보낸 뒤 SharedArrayBuffer 신호를 Atomics.wait로 기다리고
 * receiveMessageOnPort로 응답을 꺼낸다. 호출 하나(계약 함수와 parse 왕복 전부)는 시간 상한 하나를 함께 쓴다.
 * 시간 상한을 넘기거나 워커가 멈추면(비정상 종료, 메모리 상한) 워커를 끝내고, 대기 시간 동안은 워커를 띄우지 않고
 * 바로 실패로 답한다. 대기 시간이 지난 뒤의 호출이 워커를 다시 띄우며, 기동을 기다리는 시간도 그 호출의 상한 안에 든다.
 * 워커는 결함 격리(끝나지 않는 실행, 비정상 종료, 메모리 과다)를 위한 것이며 보안 경계가 아니다.
 * 워커는 같은 프로세스의 권한(파일 시스템, 네트워크, 자식 프로세스, 환경 변수)을 그대로 가진다.
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 */

import { Worker, MessageChannel, receiveMessageOnPort, type MessagePort } from "node:worker_threads";
import { UnrecognizedOutputError, type IsolatedParser, type IsolatedParseResult,
         type ParseContext, type ParserContract } from "../registry.js";
import { collectFlagValues } from "../format.js";

/** 격리 실행 상한 */
export interface IsolationLimits {
  /** 호출 하나(계약 함수와 parse 왕복 전부)의 시간 상한(ms) */
  timeLimitMs:       number;
  /** 워커 V8 힙(old generation) 상한(MB). Buffer와 ArrayBuffer처럼 힙 밖에 잡는 메모리는 제한하지 않는다. */
  memoryLimitMb:     number;
  /** 워커 기동과 팩 모듈 로드의 시간 상한(ms) */
  startupTimeoutMs?: number;
  /** 워커 장애 뒤 처음 대기 시간(ms). 장애가 이어지면 두 배씩 늘린다. */
  cooldownMs?:       number;
  /** 대기 시간의 최댓값(ms) */
  cooldownMaxMs?:    number;
}

const DEFAULT_STARTUP_TIMEOUT_MS = 2000;
const DEFAULT_COOLDOWN_MS        = 2000;
const DEFAULT_COOLDOWN_MAX_MS    = 30_000;

/** 워커 스크립트. 소스 실행과 빌드 결과 모두 이 모듈 옆에 있다. */
const WORKER_URL = new URL("./worker.js", import.meta.url);

/** 공유 신호 값. worker.js와 같아야 한다. */
const SIGNAL_IDLE    = 0;
const SIGNAL_REPLIED = 1;
const SIGNAL_EXITED  = 2;

/** 계약 안의 함수 자리를 나타내는 표식 키. worker.js와 같아야 한다. */
const FN_MARKER = "__parism_fn__";

type Request =
  | { op: "parse";  args: string[]; raw: string; ctx?: ParseContext; strict: boolean; flagValues?: Record<string, string> }
  | { op: "values"; args: string[]; flagValues: Record<string, string> }
  | { op: "call";   path: (string | number)[]; args: unknown[] };

/** 워커가 계약 정규식을 워커 안에서 평가해 돌려준 결과 */
interface ContractFactsWire {
  dataLines?: number;
  rowLines?: number;
  values?:  Record<string, boolean>;
}

interface Reply {
  id:               number;
  ok:               boolean;
  value?:           unknown;
  facts?:           ContractFactsWire;
  schemaViolation?: string;
  error?:           { name: string; message: string };
}

/** 워커 하나. ready는 팩 모듈 로드 응답을 받았는지, startedAt은 워커를 띄운 시각이다. */
interface Session {
  worker:    Worker;
  port:      MessagePort;
  state:     Int32Array;
  startedAt: number;
  ready:     boolean;
}

interface PackMetadata {
  name:     string;
  contract: Record<string, unknown>;
}

/** 워커가 상한 안에 답하지 않았거나(timeout) 끝나서(exited) 응답을 받지 못했을 때 */
class WorkerUnavailableError extends Error {
  constructor(readonly kind: "timeout" | "exited", message: string) {
    super(message);
    this.name = "WorkerUnavailableError";
  }
}

/** 워커를 띄운다. 팩 모듈 로드 응답(id 0)은 기다리지 않는다. */
function spawnSession(packDir: string, limits: IsolationLimits, label: string): Session {
  const { port1, port2 } = new MessageChannel();
  const signal           = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT);
  const worker           = new Worker(WORKER_URL, {
    workerData:     { packDir, port: port2, signal },
    transferList:   [port2],
    resourceLimits: { maxOldGenerationSizeMb: limits.memoryLimitMb },
  });
  worker.unref();
  worker.on("error", (err: Error & { code?: string }) => {
    process.stderr.write(`[parism] WARNING: external parser ${label} worker stopped: ${err.code ?? err.message}\n`);
  });
  return { worker, port: port1, state: new Int32Array(signal), startedAt: performance.now(), ready: false };
}

/**
 * 워커 하나를 띄우고 팩 모듈 로드가 끝날 때까지 기다린다.
 * 로드에 실패하면 워커를 끝내고 예외를 던진다.
 */
function startSession(packDir: string, limits: IsolationLimits, label: string): { session: Session; meta: PackMetadata } {
  const session = spawnSession(packDir, limits, label);
  const startup = limits.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS;
  let reply: Reply;
  try {
    reply = awaitReply(session, 0, startup, `did not start within ${startup} ms`);
  } catch (err) {
    stopSession(session);
    throw new Error(`External parser ${label} ${(err as Error).message}`, { cause: err });
  }
  if (!reply.ok) {
    stopSession(session);
    throw new Error(reply.error?.message ?? `External parser ${label} failed to load`);
  }
  session.ready = true;
  return { session, meta: reply.value as PackMetadata };
}

function stopSession(session: Session): void {
  session.port.close();
  void session.worker.terminate();
}

/**
 * 응답 id가 올 때까지 메인 스레드를 막고 기다린다.
 * 상한을 넘기거나 워커가 끝났다는 신호를 받으면 WorkerUnavailableError를 던진다.
 */
function awaitReply(session: Session, id: number, timeoutMs: number, timeoutMessage: string): Reply {
  const deadline = performance.now() + timeoutMs;
  for (;;) {
    const received = receiveMessageOnPort(session.port);
    if (received) {
      const reply = received.message as Reply;
      if (reply.id === id) return reply;
      continue;
    }
    if (Atomics.load(session.state, 0) === SIGNAL_EXITED) throw new WorkerUnavailableError("exited", "worker stopped unexpectedly");
    const remaining = deadline - performance.now();
    if (remaining <= 0) throw new WorkerUnavailableError("timeout", timeoutMessage);
    Atomics.wait(session.state, 0, SIGNAL_IDLE, remaining);
  }
}

/**
 * 워커에서 실행하는 외부 ParserPack.
 * 워커는 처음 로드할 때 띄운다. 장애로 끝낸 뒤에는 대기 시간 동안 호출을 바로 실패로 돌려보내고,
 * 대기 시간이 지난 뒤의 호출이 워커를 다시 띄운다.
 */
class IsolatedPackHost implements IsolatedParser {
  readonly name:      string;
  readonly contract:  ParserContract;
  private session:    Session | null;
  private seq         = 0;
  /** 진행 중인 호출의 마감 시각. 호출 밖이면 null */
  private deadline:   number | null = null;
  /** 진행 중인 호출에서 워커가 답했는지, 워커 장애가 있었는지 */
  private answered    = false;
  private faulted     = false;
  /** 성공한 호출 없이 이어진 워커 장애 수와 대기가 끝나는 시각 */
  private failures    = 0;
  private pausedUntil = 0;

  constructor(private readonly packDir: string, private readonly limits: IsolationLimits) {
    const { session, meta } = startSession(packDir, limits, `in ${packDir}`);
    this.session  = session;
    this.name     = meta.name;
    this.contract = this.bindFunctions(meta.contract) as ParserContract;
    this.watch(session);
  }

  parse(args: string[], raw: string, ctx: ParseContext | undefined, strictSchemas: boolean): IsolatedParseResult {
    /**
     * acceptedValues 판정에 쓸 '플래그 이름 -> 값' 은 정규식을 쓰지 않는 토크나이저로 메인 스레드에서 모은다.
     * 판정 자체는 워커 안에서 한다(외부 팩 정규식을 메인 스레드에서 돌리면 시간 상한을 우회한다).
     */
    const flagValues = collectFlagValues(this.contract, args);
    const reply = this.request({ op: "parse", args, raw, ...(ctx && { ctx }), strict: strictSchemas, flagValues });
    const facts = reply.facts;
    return {
      parsed: reply.value,
      ...(reply.schemaViolation !== undefined && { schemaViolation: reply.schemaViolation }),
      ...(facts && {
        facts: {
          ...(facts.dataLines !== undefined && { dataLines: facts.dataLines }),
          ...(facts.rowLines !== undefined && { rowLines: facts.rowLines }),
        },
      }),
    };
  }

  /**
   * 계약의 acceptedValues 판정을 워커 안에서 수행해 '플래그 이름 -> 판정' 을 돌려준다.
   * 워커가 멈췄거나 기동 중이면 빈 판정(모두 거절)을 돌려 검증 없이 통과하는 일을 막는다.
   */
  evalValues(args: string[], flagValues: Record<string, string>): Record<string, boolean> {
    try {
      const reply = this.request({ op: "values", args, flagValues });
      return (reply.value as Record<string, boolean> | undefined) ?? {};
    } catch {
      return {};
    }
  }

  /**
   * task 안의 워커 왕복이 시간 상한 하나를 함께 쓰게 한다. 이미 호출 안이면 바깥 마감을 그대로 쓴다.
   * 워커가 답했고 장애가 없었던 호출은 이어진 장애 수를 되돌린다.
   */
  withDeadline<T>(task: () => T): T {
    if (this.deadline !== null) return task();
    this.deadline = performance.now() + this.limits.timeLimitMs;
    this.answered = false;
    this.faulted  = false;
    try {
      return task();
    } finally {
      this.deadline = null;
      if (this.answered && !this.faulted) this.failures = 0;
    }
  }

  async close(): Promise<void> {
    const session = this.session;
    this.session  = null;
    if (!session) return;
    session.port.close();
    await session.worker.terminate();
  }

  /** 요청을 보내고 응답을 기다린다. 파서 오류는 레지스트리가 분류할 수 있는 예외로 바꾼다. */
  private request(request: Request): Reply {
    const reply = this.withDeadline(() => this.exchange(request));
    if (reply.ok) return reply;

    const message = reply.error?.message ?? "unknown error";
    if (reply.error?.name === "UnrecognizedOutputError") throw new UnrecognizedOutputError(message);
    throw new Error(message);
  }

  /** 대기 시간과 기동 상태를 확인하고 요청 하나를 남은 상한 안에서 주고받는다. */
  private exchange(request: Request): Reply {
    const now = performance.now();
    if (now < this.pausedUntil) {
      throw new Error(`External parser '${this.name}' is paused for ${Math.ceil(this.pausedUntil - now)} ms after its worker stopped`);
    }
    const session = this.session ?? this.respawn();
    if (!session.ready) this.awaitStartup(session);

    const remaining = this.remaining();
    if (remaining <= 0) throw new Error(`External parser '${this.name}' used up its ${this.limits.timeLimitMs} ms call limit`);
    if (Atomics.compareExchange(session.state, 0, SIGNAL_REPLIED, SIGNAL_IDLE) === SIGNAL_EXITED) {
      this.fail(session, "worker stopped unexpectedly");
    }
    const id = ++this.seq;
    session.port.postMessage({ ...request, id });

    try {
      const reply   = awaitReply(session, id, remaining, `did not answer within ${this.limits.timeLimitMs} ms`);
      this.answered = true;
      return reply;
    } catch (err) {
      return this.fail(session, (err as Error).message, err);
    }
  }

  /**
   * 다시 띄운 워커의 팩 모듈 로드를 호출의 남은 상한 안에서 기다린다.
   * 기동 상한 안이면 워커를 둔 채 이 호출만 실패로 끝내고, 기동 상한을 넘기거나 로드에 실패하면 장애로 처리한다.
   */
  private awaitStartup(session: Session): void {
    const startup     = this.limits.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS;
    const startupLeft = session.startedAt + startup - performance.now();
    let reply: Reply;
    try {
      reply = awaitReply(session, 0, Math.min(this.remaining(), startupLeft), `did not start within ${startup} ms`);
    } catch (err) {
      const stillStarting = err instanceof WorkerUnavailableError && err.kind === "timeout"
        && performance.now() < session.startedAt + startup;
      if (stillStarting) {
        throw new Error(`External parser '${this.name}' is still starting; the call stopped at its ${this.limits.timeLimitMs} ms limit`, { cause: err });
      }
      const reason = err instanceof WorkerUnavailableError && err.kind === "timeout" ? `did not start within ${startup} ms` : (err as Error).message;
      return this.fail(session, reason, err);
    }
    if (!reply.ok) this.fail(session, `failed to load: ${reply.error?.message ?? "unknown error"}`);
    session.ready = true;
  }

  /** 진행 중인 호출의 남은 시간(ms) */
  private remaining(): number {
    return (this.deadline ?? performance.now() + this.limits.timeLimitMs) - performance.now();
  }

  /** 워커 장애를 기록하고 워커를 끝낸 뒤 대기 시간을 알리는 예외를 던진다. */
  private fail(session: Session, reason: string, cause?: unknown): never {
    if (this.session === session) this.session = null;
    stopSession(session);
    const pause = this.recordFailure();
    throw new Error(`External parser '${this.name}' ${reason}; its worker was stopped and restarts after ${pause} ms`, { cause });
  }

  /** 장애 수를 늘리고 대기 시간을 정한다. 대기 시간은 처음 값에서 두 배씩 늘어 최댓값에서 멈춘다. */
  private recordFailure(): number {
    const base  = this.limits.cooldownMs    ?? DEFAULT_COOLDOWN_MS;
    const max   = this.limits.cooldownMaxMs ?? DEFAULT_COOLDOWN_MAX_MS;
    const pause = Math.min(base * 2 ** Math.min(this.failures, 30), max);
    this.failures++;
    this.faulted     = true;
    this.pausedUntil = performance.now() + pause;
    return pause;
  }

  private respawn(): Session {
    const session = spawnSession(this.packDir, this.limits, `'${this.name}'`);
    this.session  = session;
    this.watch(session);
    return session;
  }

  /** 워커가 호출 밖에서 스스로 끝나면 장애로 기록하고 세션을 비운다. */
  private watch(session: Session): void {
    session.worker.once("exit", () => {
      if (this.session !== session) return;
      this.session = null;
      this.recordFailure();
    });
  }

  /** 계약의 함수 표식을 워커 호출 대리 함수로 바꾼다. */
  private bindFunctions(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(item => this.bindFunctions(item));
    if (typeof value !== "object" || value === null || Object.getPrototypeOf(value) !== Object.prototype) return value;
    const marker = (value as Record<string, unknown>)[FN_MARKER];
    if (Array.isArray(marker)) {
      const path = marker as (string | number)[];
      return (...args: unknown[]) => this.request({ op: "call", path, args }).value;
    }
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, this.bindFunctions(v)]));
  }
}

/**
 * packDir의 parser.js를 워커에서 읽어 격리 실행 파서를 만든다.
 * 메인 스레드는 팩 모듈을 실행하지 않는다. 로드 실패나 기동 상한 초과는 예외로 알린다.
 */
export function loadIsolatedPack(packDir: string, limits: IsolationLimits): IsolatedParser {
  return new IsolatedPackHost(packDir, limits);
}
