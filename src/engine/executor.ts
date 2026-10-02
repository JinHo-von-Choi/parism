import { spawn, type ChildProcess } from "node:child_process";
import type { ResponseEnvelope, FailureInfo } from "../types/envelope.js";
import { takeSnapshot, computeDiff } from "./state-tracker.js";

/** stdout, stderr 각각의 수집 상한 */
const MAX_BUFFER_BYTES = 10 * 1024 * 1024; // 10 MB

/**
 * process.env에서 시크릿 패턴과 일치하는 변수를 제거한 환경 객체를 반환한다.
 * patterns의 각 항목을 환경 변수명의 대문자 substring으로 검사한다.
 */
function buildSanitizedEnv(secretPatterns: string[]): NodeJS.ProcessEnv {
  if (secretPatterns.length === 0) return process.env;

  const sanitized: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    const upper = key.toUpperCase();
    if (!secretPatterns.some(p => upper.includes(p.toUpperCase()))) {
      sanitized[key] = value;
    }
  }
  return sanitized;
}

/**
 * 텍스트가 maxBytes(UTF-8)를 넘으면 마지막 완전한 줄까지 잘라 표지 줄을 붙인다. maxBytes 가 0 이하면 그대로 둔다.
 */
export function truncateUtf8Lines(text: string, maxBytes: number): { text: string; truncated: boolean } {
  if (maxBytes <= 0 || Buffer.byteLength(text, "utf8") <= maxBytes) {
    return { text, truncated: false };
  }
  const partial     = Buffer.from(text, "utf8").subarray(0, maxBytes).toString("utf8");
  const lastNewline = partial.lastIndexOf("\n");
  const kept        = lastNewline > 0 ? partial.slice(0, lastNewline + 1) : partial;
  return { text: `${kept}...[truncated: output exceeded ${maxBytes} bytes]\n`, truncated: true };
}

/** runProcess 결과 */
interface ProcessOutcome {
  stdout:   string;
  stderr:   string;
  code:     number | null;
  timedOut: boolean;
  overflow: boolean;
  /** 프로세스를 띄우지 못했을 때의 오류 */
  error?:   NodeJS.ErrnoException;
}

/**
 * 종료 신호를 보낸 뒤 자식이 끝나고 남은 출력을 받을 때까지 기다리는 시간.
 * 프로세스 그룹 밖의 자손이 출력 파이프를 물고 있어도 이 시간이 지나면 스트림을 닫고 결과를 확정한다.
 */
const KILL_GRACE_MS = 200;

/** 실행 중인 자식의 프로세스 그룹 id(그룹 리더 pid). 결과가 확정되면 지운다. */
const liveGroups = new Set<number>();

let shutdownHooksInstalled = false;

/** 추적 중인 프로세스 그룹 id 집합 */
export function trackedProcessGroups(): ReadonlySet<number> {
  return liveGroups;
}

/**
 * 추적 중인 프로세스 그룹 전체에 SIGKILL을 보낸다. 실패는 무시한다.
 * 서버 종료 시 끝나지 않는 실행이 남지 않게 한다.
 */
export function terminateProcessGroups(): void {
  for (const pgid of liveGroups) {
    try {
      process.kill(-pgid, "SIGKILL");
    } catch {
      /** 그룹이 이미 없거나 신호를 보낼 수 없으면 할 일이 없다. */
    }
  }
}

/**
 * 종료 신호를 받으면 추적 중인 그룹을 정리한다.
 * 다른 처리기가 없으면 같은 신호를 다시 보내 기본 종료 동작을 유지한다.
 */
function onShutdownSignal(signal: NodeJS.Signals): void {
  terminateProcessGroups();
  if (process.listenerCount(signal) === 0) process.kill(process.pid, signal);
}

/** SIGINT, SIGTERM, 프로세스 종료 시 그룹 정리 처리기를 한 번만 등록한다. */
function installShutdownHooks(): void {
  if (shutdownHooksInstalled) return;
  shutdownHooksInstalled = true;
  process.once("SIGINT", onShutdownSignal);
  process.once("SIGTERM", onShutdownSignal);
  process.once("exit", terminateProcessGroups);
}

/**
 * 자식 프로세스와 그 자손을 종료한다.
 * POSIX에서는 자식이 새 프로세스 그룹의 리더이므로 음수 pid로 그룹 전체에 SIGKILL을 보낸다.
 * 그룹이 이미 없으면(ESRCH) 할 일이 없다. 그 밖의 실패와 Windows에서는 자식에게만 신호를 보낸다.
 */
function killProcessTree(child: ChildProcess, useGroup: boolean): void {
  if (useGroup && child.pid !== undefined) {
    try {
      process.kill(-child.pid, "SIGKILL");
      return;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ESRCH") return;
    }
  }
  child.kill("SIGKILL");
}

/**
 * 셸 없이 명령을 실행하고 종료까지 stdout, stderr를 모은다.
 * POSIX에서는 새 프로세스 그룹으로 띄워, 시간 초과나 버퍼 상한 초과 시 손자 프로세스까지 함께 종료한다.
 * 종료시킨 뒤에는 자식이 끝나고 KILL_GRACE_MS가 지나면 스트림을 닫고 결과를 확정한다.
 * 실행 중인 그룹은 서버 종료 시 정리할 수 있도록 추적한다.
 * timeoutMs가 0이면 시간 제한을 두지 않는다. 프로세스를 띄우지 못하면 error를 채워 돌려준다.
 */
function runProcess(
  cmd:       string,
  args:      string[],
  cwd:       string,
  env:       NodeJS.ProcessEnv,
  timeoutMs: number,
): Promise<ProcessOutcome> {
  const useGroup = process.platform !== "win32";

  return new Promise((resolve) => {
    let child: ChildProcess;
    try {
      child = spawn(cmd, args, { cwd, env, detached: useGroup, windowsHide: true });
    } catch (err) {
      resolve({ stdout: "", stderr: (err as Error).message, code: null, timedOut: false, overflow: false, error: err as NodeJS.ErrnoException });
      return;
    }

    const pgid = useGroup ? child.pid : undefined;
    if (pgid !== undefined) {
      installShutdownHooks();
      liveGroups.add(pgid);
    }

    const out:  Buffer[] = [];
    const err:  Buffer[] = [];
    const size  = { out: 0, err: 0 };
    let timedOut = false;
    let overflow = false;
    let settled  = false;
    let killed   = false;
    let exited   = false;
    let exitCode: number | null = null;
    let grace:    NodeJS.Timeout | undefined;

    const finish = (code: number | null, error?: NodeJS.ErrnoException) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (grace) clearTimeout(grace);
      if (pgid !== undefined) liveGroups.delete(pgid);
      resolve({
        stdout: Buffer.concat(out).toString("utf8"),
        stderr: Buffer.concat(err).toString("utf8"),
        code,
        timedOut,
        overflow,
        ...(error && { error }),
      });
    };

    /** 종료시킨 자식이 끝났으면 유예 시간 뒤 스트림을 닫고 결과를 확정한다. */
    const settleAfterKill = () => {
      if (!killed || !exited || grace || settled) return;
      grace = setTimeout(() => {
        child.stdout?.destroy();
        child.stderr?.destroy();
        finish(exitCode);
      }, KILL_GRACE_MS);
    };

    const terminate = () => {
      if (killed) return;
      killed = true;
      killProcessTree(child, useGroup);
      settleAfterKill();
    };

    const timer = timeoutMs > 0
      ? setTimeout(() => { timedOut = true; terminate(); }, timeoutMs)
      : undefined;

    const collect = (chunks: Buffer[], key: "out" | "err") => (chunk: Buffer) => {
      if (overflow) return;
      const room = MAX_BUFFER_BYTES - size[key];
      if (chunk.length > room) {
        chunks.push(chunk.subarray(0, room));
        size[key] = MAX_BUFFER_BYTES;
        overflow  = true;
        terminate();
        return;
      }
      chunks.push(chunk);
      size[key] += chunk.length;
    };
    child.stdout?.on("data", collect(out, "out"));
    child.stderr?.on("data", collect(err, "err"));

    child.on("error", (e: NodeJS.ErrnoException) => finish(null, e));
    child.on("exit", (code: number | null) => {
      exited   = true;
      exitCode = code;
      settleAfterKill();
    });
    child.on("close", (code: number | null) => finish(code));
  });
}

/**
 * 실행 결과를 failure 분류로 바꾼다. 성공이면 undefined.
 *   시간 초과 → timeout, 버퍼 상한 초과 → output_overflow,
 *   ENOENT/EACCES(스폰 실패) → spawn_failed, 그 외 비정상 종료 → non_zero_exit
 */
function classifyFailure(cmd: string, args: string[], r: ProcessOutcome, timeoutMs: number): FailureInfo | undefined {
  const cmdline = [cmd, ...args].join(" ");
  if (r.timedOut) {
    return { kind: "exec", reason: "timeout", message: `Command timed out after ${timeoutMs} ms: ${cmdline}` };
  }
  if (r.overflow) {
    return { kind: "exec", reason: "output_overflow", message: `Output exceeded ${MAX_BUFFER_BYTES} bytes: ${cmdline}` };
  }
  if (r.error) {
    const reason = r.error.code === "ENOENT" || r.error.code === "EACCES" ? "spawn_failed" : "non_zero_exit";
    return { kind: "exec", reason, message: r.error.message };
  }
  if (r.code !== 0) {
    return { kind: "exec", reason: "non_zero_exit", message: `Command failed: ${cmdline}\n${r.stderr}` };
  }
  return undefined;
}

/**
 * 지정한 명령을 실행하고 ResponseEnvelope를 반환한다.
 * - 셸을 거치지 않으므로 셸 확장/인젝션 위험 없음
 * - secretPatterns에 해당하는 환경 변수는 자식 프로세스에 전달하지 않음
 * - 실행 실패(명령 없음 포함)는 예외 대신 ok=false 봉투로 반환
 * - 시간 초과 시 자식이 띄운 프로세스까지 프로세스 그룹 단위로 종료한다(POSIX)
 * - includeDiff=false면 파일시스템 스냅샷을 생략하여 지연을 줄인다 (MCP 고빈도 호출 권장)
 */
export async function execute(
  cmd:             string,
  args:            string[],
  cwd:             string,
  secretPatterns:  string[] = [],
  timeoutMs:       number   = 10000,
  maxOutputBytes:  number   = 0,      // 0 = 무제한
  includeDiff:     boolean  = true,
): Promise<ResponseEnvelope> {
  const start   = Date.now();
  const before  = includeDiff ? await takeSnapshot(cwd) : null;
  const env     = { ...buildSanitizedEnv(secretPatterns), LC_ALL: "C", LANG: "C" };
  const result  = await runProcess(cmd, args, cwd, env, timeoutMs);
  const after   = includeDiff ? await takeSnapshot(cwd) : null;
  const failure = classifyFailure(cmd, args, result, timeoutMs);

  // 출력 크기 제한: 초과 시 마지막 완전한 줄까지 잘라내고 truncated=true 표시
  const out = truncateUtf8Lines(result.stdout, maxOutputBytes);
  const err = truncateUtf8Lines(result.stderr, maxOutputBytes);

  return {
    ok:          failure === undefined,
    exitCode:    failure === undefined ? 0 : (result.code !== null && result.code !== 0 ? result.code : 1),
    cmd,
    args,
    cwd,
    duration_ms: Date.now() - start,
    stdout:      { raw: out.text, parsed: null },
    stderr:      { raw: err.text, parsed: null },
    diff:        before && after ? computeDiff(before, after) : null,
    ...(failure && { failure }),
    ...(out.truncated || err.truncated ? { truncated: true } : {}),
  };
}
