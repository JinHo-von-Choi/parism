/**
 * 네이티브 정규식 엔진 프로세스.
 *
 * ## 왜 프로세스인가
 *
 * 역추적 불가능 정규식 엔진(`regex` 크레이트)을 Rust 로 만들었다. Node 네이티브 애드온(napi)이면
 * 더 빠르지만 빌드 도구체인을 요구하고 크로스 빌드 매트릭스를 따라야 한다. 프로세스는
 * **사전 빌드된 바이너리 하나**로 끝나고 어떤 플랫폼에서든 같은 방식으로 돌아간다.
 *
 * 프로토콜은 **길이 프레이밍**이다. JSON 이 아니다 — 의존을 `regex` 하나만 유지하기 위해서다.
 *
 * ## 좌표계
 *
 * 엔진은 **바이트 오프셋**을 돌려준다. JavaScript 문자열 인덱스는 UTF-16 코드유닛이라
 * 두 좌표계가 다르다. 변환은 `regex-engine.ts` 가 한다 — 여기서 섞지 않는다.
 *
 * ## 실패 대처
 *
 * - **패턴을 엔진이 못 처리한다** → `NativePatternError`. 호출하는 쪽이 TypeScript 로 되돌린다.
 * - **프로세스 자체가 죽었다/없다** → `NativeUnavailableError`. 같은 방식으로 되돌린다.
 *
 * 어느 쪽이든 조용히 넘어가지 않는다. 되돌아간 사실은 호출하는 쪽이 기록한다.
 *
 * 작성자: 최진호
 * 작성일: 2026-10-22
 */

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** 엔진이 돌려주는 매칭 위치. **바이트 오프셋**이다. */
export interface NativeMatch {
  start: number;
  end: number;
}

/** 엔진 오류 종류. */
export type NativeErrorKind = "unsupported" | "invalid" | "too_large";

/** 패턴을 엔진이 처리하지 못했다. */
export class NativePatternError extends Error {
  constructor(readonly kind: NativeErrorKind, message: string) {
    super(message);
    this.name = "NativePatternError";
  }
}

/** 엔진 프로세스를 쓸 수 없다. */
export class NativeUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NativeUnavailableError";
  }
}

/** 네이티브 엔진이 제공하는 연산. */
export interface NativeRegex {
  /** 패턴을 엔진이 처리할 수 있는지 확인한다. 처리 못 하면 `NativePatternError`. */
  validate(pattern: string): Promise<void>;
  /** 첫 매칭 위치(바이트 오프셋). 없으면 null. */
  findFirst(pattern: string, text: string): Promise<NativeMatch | null>;
  /** 모든 매칭 위치(바이트 오프셋). 빈 매칭도 포함된다. */
  findAll(pattern: string, text: string): Promise<NativeMatch[]>;
  /** 같은 텍스트에 여러 패턴을 한 번에 적용한다. */
  findAllMany(patterns: string[], text: string): Promise<NativeMatch[][]>;
  /**
   * 모든 매칭을 치환한다.
   *
   * `exact` 가 false 면 **JavaScript 와 같은 결과가 아니라는 뜻**이다.
   * 빈 매칭이 있고 텍스트에 BMP 밖 문자가 있으면 Rust 로 재현할 수 없다.
   */
  replaceAll(pattern: string, text: string, replacement: string, literal: boolean): Promise<{ text: string; exact: boolean }>;
  /**
   * 엔진이 표준 오류에 남긴 것.
   *
   * 엔진의 표준 오류는 **MCP 표준 입출력과 섞이면 안 된다.** 프로토콜이 깨진다.
   * 그래서 모아만 둔다 — 진단용으로 남긴다.
   */
  stderr(): string;
  /** 프로세스를 끝낸다. */
  close(): void;
}

const OP_VALIDATE     = 1;
const OP_FIND_FIRST   = 2;
const OP_FIND_ALL     = 3;
const OP_FIND_ALL_MANY = 4;
const OP_REPLACE_ALL  = 5;

const KIND_NONE        = 0;
const KIND_UNSUPPORTED = 1;
const KIND_INVALID     = 2;
const KIND_TOO_LARGE   = 3;

/** 프로토콜의 오류 종류 번호를 이름에 대응시킨다. */
const KIND_NAMES: Record<number, NativeErrorKind> = {
  [KIND_UNSUPPORTED]: "unsupported",
  [KIND_INVALID]:    "invalid",
  [KIND_TOO_LARGE]:  "too_large",
};

/** 요청 제한 시간의 기본값(밀리초). */
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;

/**
 * 요청 제한 시간.
 *
 * 엔진은 외부 프로세스다. **죽지 않고 침묵할 수 있다** — 깨진 프레임을 보내고
 * 입력을 더 읽지 않는 경우(실측)가 그렇다. 그때 요청이 영영 끝나지 않으면
 * MCP 서버의 그 요청만 멈춘다 — 서버 전체가 아니라 **그 요청만.**
 *
 * 그래서 제한 시간이 필요하다. 넘으면 실패로 돌리고 호출하는 쪽은 TypeScript 로 되돌아간다.
 * 환경변수로 좁힐 수 있다 — 큰 텍스트를 다룰 때 늘리면 된다.
 */
export function requestTimeoutMs(): number {
  const raw    = process.env.PARISM_REGEX_TIMEOUT_MS;
  if (!raw) return DEFAULT_REQUEST_TIMEOUT_MS;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_REQUEST_TIMEOUT_MS;
}

/** 이 모듈의 위치. 패키지 루트를 찾기 위해 쓴다. */
const moduleDir = path.dirname(fileURLToPath(import.meta.url));

/** 이 호스트가 musl 이면 true. glibc 런타임이 없으면 musel 로 추정한다. */
function isMusl(): boolean {
  const report = process.report?.getReport?.() as { header?: { glibcVersionRuntime?: string } } | undefined;
  return !report?.header?.glibcVersionRuntime;
}

/**
 * 이 호스트에 맞는 npm 플랫폼 패키지 이름.
 *
 * 규칙은 `scripts/native-platforms.mjs` 의 목록과 **반드시 같아야 한다.**
 * 한쪽만 고치면 그 호스트에서 엔진이 조용히 사라진다 — 아무도 모르는 채로.
 */
export function nativePackageName(): string {
  const base = `parism-regex-${process.platform}-${process.arch}`;
  if (process.platform === "linux") return isMusl() ? `${base}-musl` : `${base}-gnu`;
  /** Windows 는 CRT 가 msvc 하나뿐이다 — 이름에도 적는다. */
  if (process.platform === "win32") return `${base}-msvc`;
  return base;
}

/** 이 호스트의 엔진 바이너리 파일 이름. */
function binaryFileName(): string {
  return process.platform === "win32" ? "parism-regex.exe" : "parism-regex";
}

/**
 * 바이너리 경로를 찾는다.
 *
 * 찾지 못하면 `undefined` 다 — 엔진이 없는 상태로 돌아간다.
 */
export function resolveNativeBinary(): string | undefined {
  const override = process.env.PARISM_REGEX_BIN;
  if (override) {
    /**
     * 환경변수는 **명시적 지정**이다. 없으면 조용히 다른 곳을 찾지 않는다 —
     * "이 바이너리로 돌려라" 를 무시하고 다른 걸 쓰는 것은 조용한 계약 위반이다.
     */
    if (existsSync(override)) return override;
    process.stderr.write(`[parism] PARISM_REGEX_BIN does not exist: ${override}\n`);
    return undefined;
  }

  /** npm 플랫폼 패키지가 설치된 경우. */
  try {
    const require = createRequire(import.meta.url);
    const pkg = require.resolve(`@nerdvana/${nativePackageName()}/package.json`);
    const candidate = path.join(path.dirname(pkg), "bin", binaryFileName());
    if (existsSync(candidate)) return candidate;
  } catch {
    /** 플랫폼 패키지가 없다. 다음 후보를 본다. */
  }

  /** 개발 중 — 저장소 안에서 직접 빌드한 바이너리. */
  const repoRoot = path.resolve(moduleDir, "..", "..");
  for (const profile of ["release", "debug"]) {
    const candidate = path.join(repoRoot, "crates", "parism-regex", "target", profile, binaryFileName());
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

/** 요청을 바이트로 직렬화한다. */
function encodeRequest(
  op: number, id: number, patterns: string[], text: string, replacement: string, literal: boolean,
): Buffer {
  const chunks: Buffer[] = [];
  const head = Buffer.alloc(1 + 4 + 4);
  head.writeUInt8(op, 0);
  head.writeUInt32LE(id, 1);
  head.writeUInt32LE(patterns.length, 5);
  chunks.push(head);

  for (const pattern of patterns) {
    const bytes = Buffer.from(pattern, "utf8");
    const len   = Buffer.alloc(4);
    len.writeUInt32LE(bytes.length, 0);
    chunks.push(len, bytes);
  }
  for (const value of [text, replacement]) {
    const bytes = Buffer.from(value, "utf8");
    const len   = Buffer.alloc(4);
    len.writeUInt32LE(bytes.length, 0);
    chunks.push(len, bytes);
  }
  const literalByte = Buffer.alloc(1);
  literalByte.writeUInt8(literal ? 1 : 0, 0);
  chunks.push(literalByte);
  return Buffer.concat(chunks);
}

/** 응답 프레임 하나를 읽는다. */
interface Frame {
  status: number;
  id:     number;
  kind:   number;
  message: string;
  body:   Buffer;
}

/**
 * 프레임 본문의 최소 크기.
 *
 * `status u8 | id u32 | kind u8 | messageLen u32` — 10바이트가 헤더다.
 * 이보다 짧으면 잘린 프레임이다.
 */
const FRAME_HEADER_SIZE = 10;

/**
 * 바이트 묶음에서 프레임을 하나 꺼낸다. 없으면 null.
 *
 * ## 왜 길이를 확인하는가
 *
 * 프로세스가 죽는 동안 쓰다만 응답이 **잘려서** 도착할 수 있다.
 * 길이를 확인하지 않고 읽으면 `readUInt8` 가 **범위를 벗어나 예외를 던진다.**
 * 그 예외는 stdout 의 `data` 핸들러 안에서 나므로 **Node 프로세스 전체가 죽는다.**
 *
 * 엔진 하나가 죽은 것 때문에 서버까지 죽으면 안 된다. 잘린 프레임은 그 자체로
 * "이 엔진은 더 이상 신뢰할 수 없다" 는 신호다 — 예외 대신 **명확한 오류** 로 바꾼다.
 */
export function takeFrame(buffer: Buffer<ArrayBufferLike>): { frame: Frame; rest: Buffer<ArrayBufferLike> } | null {
  if (buffer.length < 4) return null;
  const total = buffer.readUInt32LE(0);
  if (buffer.length < 4 + total) return null;
  const body = buffer.subarray(4, 4 + total);
  const rest = buffer.subarray(4 + total);

  if (body.length < FRAME_HEADER_SIZE) {
    throw new NativeUnavailableError(
      `native regex frame is truncated: body is ${body.length} bytes, header needs ${FRAME_HEADER_SIZE}`,
    );
  }

  let offset = 0;
  const status  = body.readUInt8(offset); offset += 1;
  const id      = body.readUInt32LE(offset); offset += 4;
  const kind    = body.readUInt8(offset); offset += 1;
  const msgLen  = body.readUInt32LE(offset); offset += 4;
  if (body.length < offset + msgLen) {
    throw new NativeUnavailableError(
      `native regex frame is truncated: message claims ${msgLen} bytes but only ${body.length - offset} remain`,
    );
  }
  const message = body.subarray(offset, offset + msgLen).toString("utf8"); offset += msgLen;

  return { frame: { status, id, kind, message, body: body.subarray(offset) }, rest };
}

/** 대기 중인 요청. */
interface Pending {
  resolve: (value: Frame) => void;
  reject:  (error: Error) => void;
  /** 응답 제한 시간. 응답이 오면 풀어야 한다 — 남아 있으면 프로세스가 안 끝난다. */
  timer?:  NodeJS.Timeout;
}

/**
 * 네이티브 엔진 프로세스 하나.
 *
 * 요청은 큐에 쌓여 하나씩 처리된다. 응답은 `id` 로 짝을 맞춘다.
 */
class NativeProcess implements NativeRegex {
  private child: ChildProcessWithoutNullStreams | undefined;
  private pending = new Map<number, Pending>();
  private buffer: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  private nextId  = 1;
  private dead    = false;
  /** 엔진이 표준 오류에 남긴 것. 진단용으로만 쓴다. */
  private stderrBuffer = "";

  constructor(private readonly binary: string) {}

  /** 프로세스를 띄운다. 이미 떠 있으면 그대로 쓴다. */
  private ensure(): ChildProcessWithoutNullStreams {
    if (this.dead) throw new NativeUnavailableError("native regex process is not running");
    if (this.child) return this.child;

    const child = spawn(this.binary, [], {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    this.child = child;
    /**
     * 부모가 이 프로세스 때문에 죽지 않게 한다.
     * 정규식 엔진은 보조 수단이다 — 이것이 남아 있다고 MCP 서버가 종료되지 않아야 한다.
     */
    child.unref();
    /**
     * **stdio 파이프도 이벤트 루프를 붙잡는다.**
     *
     * `unref()` 는 **프로세스 핸들** 만 놓아 준다. 파이프가 살아 있으면 Node 는 안 끝난다.
     * 그러면 MCP 서버는 괜찮지만 **CLI 명령이 끝났는데 프로세스가 안 죽는다.**
     * `parism capture` 같은 명령이 결과를 찍고도 멈춰 서 있게 되는 셈이다.
     *
     * 그래서 파이프까지 놓는다. 요청이 떠 있는 동안만 다시 붙잡는다(`send`).
     */
    this.setRef(false);

    child.stdout.on("data", (chunk: Buffer) => {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      this.drain();
    });
    /** 표준 오류는 MCP 표준 입출력과 섞이면 안 된다. 모아만 둔다. */
    child.stderr.on("data", (chunk: Buffer) => {
      this.stderrBuffer = (this.stderrBuffer + chunk.toString("utf8")).slice(-2000);
    });
    child.on("error", () => this.kill(new NativeUnavailableError(`cannot start ${this.binary}`)));
    child.on("exit", () => this.kill(new NativeUnavailableError("native regex process exited")));

    return child;
  }

  /** 버퍼에 모인 응답을 꺼내 대기 중인 요청에 넘긴다. */
  private drain(): void {
    for (;;) {
      let taken: { frame: Frame; rest: Buffer<ArrayBufferLike> } | null;
      try {
        taken = takeFrame(this.buffer);
      } catch (err) {
        /**
         * 잘린 프레임이면 이 엔진은 더 이상 믿을 수 없다.
         *
         * 예외를 밖으로 던지면 stdout 의 `data` 핸들러에서 터져 **Node 프로세스 전체가 죽는다.**
         * 엔진 하나가 죽은 것 때문에 서버까지 죽으면 안 된다.
         * 요청을 모두 실패로 돌리고 엔정을 닫는다 — 호출하는 쪽은 TypeScript 로 되돌아간다.
         */
        this.kill(err instanceof Error ? err : new NativeUnavailableError(String(err)));
        return;
      }
      if (!taken) return;
      this.buffer = taken.rest;
      const waiter = this.pending.get(taken.frame.id);
      if (!waiter) continue;
      this.pending.delete(taken.frame.id);
      /** 응답이 왔으니 시간제한을 푼다. 남아 있으면 프로세스가 안 끝난다. */
      if (waiter.timer) clearTimeout(waiter.timer);
      waiter.resolve(taken.frame);
    }
  }

  /** 프로세스가 죽었을 때 대기 중인 요청을 모두 실패로 돌린다. */
  private kill(error: Error): void {
    if (this.dead) return;
    this.dead = true;
    for (const waiter of this.pending.values()) {
      if (waiter.timer) clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    this.pending.clear();
    /** 죽은 프로세스의 파이프가 이벤트 루프를 붙잡지 않게 한다. */
    this.setRef(false);
    const child = this.child;
    this.child = undefined;
    /**
     * 늦게 도착한 출력을 읽지 않는다.
     *
     * 프로세스가 죽는 동안 쓰다만 응답이 잘려서 도착하면 **프레임 파싱이 범위를 벗어난다.**
     * 그 예외가 stdout 핸들러에서 나면 Node 를 죽인다.
     * 리스너를 떼고 스트림을 닫아 늦은 데이터가 더 이상 파싱되지 않게 한다.
     */
    child?.stdout.removeAllListeners("data");
    child?.stderr.removeAllListeners("data");
    child?.stdout.destroy();
    child?.stderr.destroy();
  }

  /** 요청 하나를 보내고 응답을 받는다. */
  private send(
    op: number, patterns: string[], text: string, replacement: string, literal: boolean,
  ): Promise<Frame> {
    let child: ChildProcessWithoutNullStreams;
    try {
      child = this.ensure();
    } catch (err) {
      return Promise.reject(err);
    }
    const id = this.nextId++;
    const payload = encodeRequest(op, id, patterns, text, replacement, literal);
    /**
     * **요청이 떠 있는 동안만** 이벤트 루프를 붙잡는다.
     * 놓아 두면 응답이 오기 전에 Node 가 종료될 수 있다 — 응답을 못 받으면 조용히 실패한다.
     */
    this.setRef(true);
    return new Promise<Frame>((resolve, reject) => {
      /**
       * **응답이 올 때까지 기다린다 — 하지만 무한히 기다리지는 않는다.**
       *
       * 엔진은 외부 프로세스다. 죽지 않고 침묵할 수도 있다 —
       * 잘린 프레임을 보내고 입력을 더 읽지 않는 경우(실측)가 그렇다.
       * 그때 요청은 영영 끝나지 않고 **MCP 서버의 그 요청만 멈춘다.**
       *
       * 그래서 시간제한을 건다. 넘으면 요청을 실패로 돌리고 엔진을 닫는다 —
       * 호출하는 쪽은 TypeScript 로 되돌아간다.
       */
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new NativeUnavailableError(
          `native regex request timed out after ${requestTimeoutMs()}ms`,
        ));
        this.kill(new NativeUnavailableError("native regex request timed out"));
      }, requestTimeoutMs());
      /** 타이머가 이벤트 루프를 붙잡지 않게 한다 — 요청이 끝나면 풀린다. */
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer });

      child.stdin.write(payload, err => {
        if (err) {
          this.pending.delete(id);
          clearTimeout(timer);
          reject(new NativeUnavailableError(`native regex request failed: ${err.message}`));
        }
      });
    }).finally(() => this.settle());
  }

  /**
   * stdio 파이프가 이벤트 루프를 붙잡지 않게 한다.
   *
   * `net.Socket` 이라 `ref`/`unref` 가 있다. 없는 스트림이면 조용히 넘긴다 —
   * 플랫폼마다 표준 입출력이 다를 수 있다.
   */
  private setRef(ref: boolean): void {
    const child = this.child;
    if (!child) return;
    for (const stream of [child.stdin, child.stdout, child.stderr]) {
      const handle = stream as unknown as { ref?: () => void; unref?: () => void };
      if (ref) handle.ref?.();
      else handle.unref?.();
    }
  }

  /** 대기 중인 요청이 없으면 이벤트 루프에서 놓는다. */
  private settle(): void {
    if (this.pending.size === 0) this.setRef(false);
  }

  /** 오류 프레임을 예외로 바꾼다. */
  private throwIfError(frame: Frame): void {
    if (frame.status === 0) return;
    throw new NativePatternError(KIND_NAMES[frame.kind] ?? "invalid", frame.message);
  }

  async validate(pattern: string): Promise<void> {
    const frame = await this.send(OP_VALIDATE, [pattern], "", "", false);
    this.throwIfError(frame);
  }

  async findFirst(pattern: string, text: string): Promise<NativeMatch | null> {
    const frame = await this.send(OP_FIND_FIRST, [pattern], text, "", false);
    this.throwIfError(frame);
    const body = frame.body;
    if (body.readUInt8(0) === KIND_NONE) return null;
    return { start: body.readUInt32LE(1), end: body.readUInt32LE(5) };
  }

  async findAll(pattern: string, text: string): Promise<NativeMatch[]> {
    const frame = await this.send(OP_FIND_ALL, [pattern], text, "", false);
    this.throwIfError(frame);
    return readMatches(frame.body);
  }

  async findAllMany(patterns: string[], text: string): Promise<NativeMatch[][]> {
    const frame = await this.send(OP_FIND_ALL_MANY, patterns, text, "", false);
    this.throwIfError(frame);
    const body = frame.body;
    const outer = body.readUInt32LE(0);
    let offset = 4;
    const out: NativeMatch[][] = [];
    for (let i = 0; i < outer; i++) {
      const count = body.readUInt32LE(offset); offset += 4;
      const matches: NativeMatch[] = [];
      for (let j = 0; j < count; j++) {
        const start = body.readUInt32LE(offset); offset += 4;
        const end   = body.readUInt32LE(offset); offset += 4;
        matches.push({ start, end });
      }
      out.push(matches);
    }
    return out;
  }

  async replaceAll(pattern: string, text: string, replacement: string, literal: boolean): Promise<{ text: string; exact: boolean }> {
    const frame = await this.send(OP_REPLACE_ALL, [pattern], text, replacement, literal);
    this.throwIfError(frame);
    const body = frame.body;
    const len  = body.readUInt32LE(0);
    const out  = body.subarray(4, 4 + len).toString("utf8");
    const exact = body.readUInt8(4 + len) === 1;
    return { text: out, exact };
  }

  /** 엔진이 표준 오류에 남긴 것. 진단용. */
  stderr(): string {
    return this.stderrBuffer;
  }

  close(): void {
    /**
     * **표준 입력을 먼저 닫는다.**
     *
     * 엔진은 표준 입력으로 EOF 를 받으면 끝난다. `kill()` 이 `child` 를 먼저 없애므로
     * 순서가 반대면 `stdin.end()` 가 실행되지 않아 자식 프로세스가 남아 있었다.
     */
    try {
      this.child?.stdin.end();
    } catch {
      /** 이미 끝난 프로세스다. */
    }
    this.kill(new NativeUnavailableError("closed"));
  }
}

/** 매칭 목록 본문을 읽는다. */
function readMatches(body: Buffer<ArrayBufferLike>): NativeMatch[] {
  const count = body.readUInt32LE(0);
  let offset = 4;
  const out: NativeMatch[] = [];
  for (let i = 0; i < count; i++) {
    const start = body.readUInt32LE(offset); offset += 4;
    const end   = body.readUInt32LE(offset); offset += 4;
    out.push({ start, end });
  }
  return out;
}

/** 만들어 둔 엔진. 프로세스당 하나. */
let instance: NativeRegex | undefined;
let resolved  = false;

/**
 * 네이티브 정규식 엔진을 얻는다.
 *
 * 바이너리가 없으면 `undefined` 다 — 그때는 TypeScript 엔진만 쓴다.
 */
export function loadNativeRegex(): NativeRegex | undefined {
  if (resolved) return instance;
  resolved = true;
  const binary = resolveNativeBinary();
  if (!binary) return undefined;
  instance = new NativeProcess(binary);
  return instance;
}

/** 시험과 재시작을 위해 캐시를 비운다. */
export function resetNativeRegex(): void {
  instance?.close();
  instance = undefined;
  resolved  = false;
}
