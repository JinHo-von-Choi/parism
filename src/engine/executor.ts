import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ResponseEnvelope } from "../types/envelope.js";
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

    // stdout 크기 제한: 초과 시 마지막 완전한 줄까지 잘라내고 truncated=true 표시
    let   outRaw:    string           = stdout;
    let   truncated: boolean | undefined;

    if (maxOutputBytes > 0 && Buffer.byteLength(outRaw, "utf8") > maxOutputBytes) {
      const buf        = Buffer.from(outRaw, "utf8").subarray(0, maxOutputBytes);
      const partial    = buf.toString("utf8");
      const lastNewline = partial.lastIndexOf("\n");
      outRaw    = lastNewline > 0 ? partial.slice(0, lastNewline + 1) : partial;
      outRaw   += `...[truncated: output exceeded ${maxOutputBytes} bytes]\n`;
      truncated = true;
    }

    return {
      ok:          true,
      exitCode:    0,
      cmd,
      args,
      cwd,
      duration_ms: Date.now() - start,
      stdout:      { raw: outRaw, parsed: null },
      stderr:      { raw: stderr, parsed: null },
      diff:        before && after ? computeDiff(before, after) : null,
      truncated,
    };
  } catch (err: unknown) {
    const e = err as NodeJS.ErrnoException & {
      code?:   string | number;
      stdout?: string;
      stderr?: string;
    };

    const exitCode = typeof e.code === "number" ? e.code : 1;
    const after    = includeDiff ? await takeSnapshot(cwd) : null;

    return {
      ok:          false,
      exitCode,
      cmd,
      args,
      cwd,
      duration_ms: Date.now() - start,
      stdout:      { raw: e.stdout ?? "", parsed: null },
      stderr:      { raw: e.stderr ?? e.message, parsed: null },
      diff:        before && after ? computeDiff(before, after) : null,
    };
  }
}
