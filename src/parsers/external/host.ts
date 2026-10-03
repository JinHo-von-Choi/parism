/**
 * 외부 ParserPack 격리 실행.
 * 팩마다 워커 스레드 하나를 두고 팩 모듈은 그 워커에서만 읽는다. 메인 스레드는 직렬화한 계약 선언만 받는다.
 * 레지스트리의 parse API는 동기라서, 메인 스레드는 요청을 보낸 뒤 SharedArrayBuffer 신호를 Atomics.wait로 기다리고
 * receiveMessageOnPort로 응답을 꺼낸다. 시간 상한을 넘기거나 워커가 멈추면(비정상 종료, 메모리 상한) 워커를 끝내고
 * 다음 호출 때 다시 띄운다.
 * 워커는 결함 격리(끝나지 않는 실행, 비정상 종료, 메모리 과다)를 위한 것이며 보안 경계가 아니다.
 * 워커는 같은 프로세스의 권한(파일 시스템, 네트워크, 자식 프로세스, 환경 변수)을 그대로 가진다.
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 */

import { Worker, MessageChannel, receiveMessageOnPort, type MessagePort } from "node:worker_threads";
import { UnrecognizedOutputError, type IsolatedParser, type IsolatedParseResult,
         type ParseContext, type ParserContract } from "../registry.js";

/** 격리 실행 상한 */
export interface IsolationLimits {
  /** parse와 계약 함수 호출 한 번의 시간 상한(ms) */
  timeLimitMs:       number;
  /** 워커 V8 힙(old generation) 상한(MB) */
  memoryLimitMb:     number;
  /** 워커 기동과 팩 모듈 로드의 시간 상한(ms) */
  startupTimeoutMs?: number;
}

const DEFAULT_STARTUP_TIMEOUT_MS = 5000;

/** 워커 스크립트. 소스 실행과 빌드 결과 모두 이 모듈 옆에 있다. */
const WORKER_URL = new URL("./worker.js", import.meta.url);

/** 공유 신호 값. worker.js와 같아야 한다. */
const SIGNAL_IDLE    = 0;
const SIGNAL_EXITED  = 2;

/** 계약 안의 함수 자리를 나타내는 표식 키. worker.js와 같아야 한다. */
const FN_MARKER = "__parism_fn__";

type Request =
  | { op: "parse"; args: string[]; raw: string; ctx?: ParseContext; strict: boolean }
  | { op: "call";  path: (string | number)[]; args: unknown[] };

interface Reply {
  id:               number;
  ok:               boolean;
  value?:           unknown;
  schemaViolation?: string;
  error?:           { name: string; message: string };
}

interface Session {
  worker: Worker;
  port:   MessagePort;
  state:  Int32Array;
}

interface PackMetadata {
  name:     string;
  contract: Record<string, unknown>;
}

/** 워커가 상한 안에 답하지 않았거나 멈춰 호출을 끝내지 못했을 때 */
class WorkerUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkerUnavailableError";
  }
}

/**
 * 워커 하나를 띄우고 팩 모듈 로드가 끝날 때까지 기다린다.
 * 로드에 실패하면 워커를 끝내고 예외를 던진다.
 */
function startSession(packDir: string, limits: IsolationLimits, label: string): { session: Session; meta: PackMetadata } {
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

  const session = { worker, port: port1, state: new Int32Array(signal) };
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
    if (Atomics.load(session.state, 0) === SIGNAL_EXITED) throw new WorkerUnavailableError("worker stopped unexpectedly");
    const remaining = deadline - performance.now();
    if (remaining <= 0) throw new WorkerUnavailableError(timeoutMessage);
    Atomics.wait(session.state, 0, SIGNAL_IDLE, remaining);
  }
}

/**
 * 워커에서 실행하는 외부 ParserPack.
 * 워커는 처음 로드할 때 띄우고, 실패로 끝낸 뒤에는 다음 호출 때 다시 띄운다.
 */
class IsolatedPackHost implements IsolatedParser {
  readonly name:     string;
  readonly contract: ParserContract;
  private session:   Session | null;
  private seq        = 0;

  constructor(private readonly packDir: string, private readonly limits: IsolationLimits) {
    const { session, meta } = startSession(packDir, limits, `in ${packDir}`);
    this.session  = session;
    this.name     = meta.name;
    this.contract = this.bindFunctions(meta.contract) as ParserContract;
    this.watch(session);
  }

  parse(args: string[], raw: string, ctx: ParseContext | undefined, strictSchemas: boolean): IsolatedParseResult {
    const reply = this.request({ op: "parse", args, raw, ...(ctx && { ctx }), strict: strictSchemas });
    return { parsed: reply.value, ...(reply.schemaViolation !== undefined && { schemaViolation: reply.schemaViolation }) };
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
    const session = this.session ?? this.respawn();
    const id      = ++this.seq;
    Atomics.store(session.state, 0, SIGNAL_IDLE);
    session.port.postMessage({ ...request, id });

    let reply: Reply;
    try {
      reply = awaitReply(session, id, this.limits.timeLimitMs, `did not answer within ${this.limits.timeLimitMs} ms`);
    } catch (err) {
      if (this.session === session) this.session = null;
      stopSession(session);
      throw new Error(`External parser '${this.name}' ${(err as Error).message}; its worker was stopped and restarts on the next call`, { cause: err });
    }
    if (reply.ok) return reply;

    const message = reply.error?.message ?? "unknown error";
    if (reply.error?.name === "UnrecognizedOutputError") throw new UnrecognizedOutputError(message);
    throw new Error(message);
  }

  private respawn(): Session {
    const { session } = startSession(this.packDir, this.limits, `'${this.name}'`);
    this.session      = session;
    this.watch(session);
    return session;
  }

  /** 워커가 스스로 끝나면 다음 호출에서 새로 띄우도록 세션을 비운다. */
  private watch(session: Session): void {
    session.worker.once("exit", () => {
      if (this.session === session) this.session = null;
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
