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

    const out:  Buffer[] = [];
    const err:  Buffer[] = [];
    const size  = { out: 0, err: 0 };
    let timedOut = false;
    let overflow = false;
    let settled  = false;

    const timer = timeoutMs > 0
      ? setTimeout(() => { timedOut = true; killProcessTree(child, useGroup); }, timeoutMs)
      : undefined;

    const collect = (chunks: Buffer[], key: "out" | "err") => (chunk: Buffer) => {
      if (overflow) return;
      const room = MAX_BUFFER_BYTES - size[key];
      if (chunk.length > room) {
        chunks.push(chunk.subarray(0, room));
        size[key] = MAX_BUFFER_BYTES;
        overflow  = true;
        killProcessTree(child, useGroup);
        return;
      }
      chunks.push(chunk);
      size[key] += chunk.length;
    };
    child.stdout?.on("data", collect(out, "out"));
    child.stderr?.on("data", collect(err, "err"));

    const finish = (code: number | null, error?: NodeJS.ErrnoException) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve({
        stdout: Buffer.concat(out).toString("utf8"),
        stderr: Buffer.concat(err).toString("utf8"),
        code,
        timedOut,
        overflow,
        ...(error && { error }),
      });
    };
    child.on("error", (e: NodeJS.ErrnoException) => finish(null, e));
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
