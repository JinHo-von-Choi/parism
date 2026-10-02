import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ResponseEnvelope, FailureInfo } from "../types/envelope.js";
import { takeSnapshot, computeDiff } from "./state-tracker.js";

const execFileAsync = promisify(execFile);

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

/**
 * 지정한 명령을 execFile로 실행하고 ResponseEnvelope를 반환한다.
 * - 셸을 거치지 않으므로 셸 확장/인젝션 위험 없음
 * - secretPatterns에 해당하는 환경 변수는 자식 프로세스에 전달하지 않음
 * - 실행 실패(명령 없음 포함)는 예외 대신 ok=false 봉투로 반환
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
  const start  = Date.now();
  const before = includeDiff ? await takeSnapshot(cwd) : null;

  try {
    const { stdout, stderr } = await execFileAsync(cmd, args, {
      cwd,
      timeout:   timeoutMs,
      maxBuffer: 10 * 1024 * 1024, // 10 MB
      env: { ...buildSanitizedEnv(secretPatterns), LC_ALL: "C", LANG: "C" },
    });

    const after = includeDiff ? await takeSnapshot(cwd) : null;

    // 출력 크기 제한: 초과 시 마지막 완전한 줄까지 잘라내고 truncated=true 표시
    const out = truncateUtf8Lines(stdout, maxOutputBytes);
    const err = truncateUtf8Lines(stderr, maxOutputBytes);
    const outRaw    = out.text;
    const truncated = out.truncated || err.truncated ? true : undefined;

    return {
      ok:          true,
      exitCode:    0,
      cmd,
      args,
      cwd,
      duration_ms: Date.now() - start,
      stdout:      { raw: outRaw, parsed: null },
      stderr:      { raw: err.text, parsed: null },
      diff:        before && after ? computeDiff(before, after) : null,
      truncated,
    };
  } catch (err: unknown) {
    const e = err as NodeJS.ErrnoException & {
      code?:   string | number;
      stdout?: string;
      stderr?: string;
      killed?: boolean;
      signal?: string;
    };

    const exitCode = typeof e.code === "number" ? e.code : 1;
    const after    = includeDiff ? await takeSnapshot(cwd) : null;

    // failure.reason 분류:
    //   killed=true (execFile timeout → SIGTERM) 또는 ETIMEDOUT → timeout
    //   maxBuffer 초과 → output_overflow
    //   ENOENT/EACCES (스폰 실패) → spawn_failed
    //   그 외 비정상 종료 → non_zero_exit
    let failure: FailureInfo;
    if (e.killed === true || e.code === "ETIMEDOUT") {
      failure = { kind: "exec", reason: "timeout",       message: e.message };
    } else if (e.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
      failure = { kind: "exec", reason: "output_overflow", message: e.message };
    } else if (e.code === "ENOENT" || e.code === "EACCES") {
      failure = { kind: "exec", reason: "spawn_failed",  message: e.message };
    } else {
      failure = { kind: "exec", reason: "non_zero_exit", message: e.message };
    }

    const failOut = truncateUtf8Lines(e.stdout ?? "", maxOutputBytes);
    const failErr = truncateUtf8Lines(e.stderr ?? e.message, maxOutputBytes);

    return {
      ok:          false,
      exitCode,
      cmd,
      args,
      cwd,
      duration_ms: Date.now() - start,
      stdout:      { raw: failOut.text, parsed: null },
      stderr:      { raw: failErr.text, parsed: null },
      diff:        before && after ? computeDiff(before, after) : null,
      failure,
      ...(failOut.truncated || failErr.truncated ? { truncated: true } : {}),
    };
  }
}
