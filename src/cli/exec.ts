/**
 * `parism exec -- "<명령>"`: 명령 한 줄을 Parism 엔진으로 실행하고 결과를 표준 출력에 쓴다.
 *
 * PreToolUse 훅이 에이전트의 Bash 호출을 이 명령으로 바꿔 실행한다. 그래서 결과는 셸에서 실행한 것과
 * 같은 방식으로 읽혀야 한다.
 *   - 종료 코드는 명령의 종료 코드를 그대로 쓴다.
 *   - 파싱 결과가 있으면 JSON 한 줄과 원문 가운데 짧은 쪽을 쓴다. 파싱 결과가 없으면 원문을 그대로 쓴다.
 *     행이 많으면(adaptive_format_threshold) JSON은 열 이름과 값 배열로 접힌 compact 형식이다.
 *   - 표준 오류는 표준 오류로 쓴다.
 * 실행은 엔진을 거치므로 가드, 시크릿 리댁션, 영수증, 사용 통계가 MCP 호출과 같이 적용된다.
 * 한 번 실행하고 끝나는 프로세스라 결과 보관(result_id)은 쓰지 않는다. 행을 미리보기로 줄이지 않는다.
 *
 * 작성자: 최진호
 * 작성일: 2026-11-12
 */

import { loadConfig, loadConfigMultiLayer, DEFAULT_OUTPUT, type PrismConfig } from "../config/loader.js";
import { createRegistry }                                   from "../parsers/index.js";
import { resolveRunner }                                    from "../parsers/devloop/index.js";
import { ParismEngine }                                     from "../facade/engine.js";
import { resolveCommand }                                   from "../facade/run-pipeline.js";
import { lexCommand, splitSequence, substituteStatus }      from "../engine/command-lexer.js";
import { existsSync, statSync }                             from "node:fs";
import os                                                   from "node:os";
import path                                                 from "node:path";
import type { ResponseEnvelope }                            from "../types/envelope.js";

export interface ExecOutcome {
  stdout:   string;
  stderr:   string;
  exitCode: number;
}

export async function configForExec(configPath: string | undefined): Promise<PrismConfig> {
  const config = configPath ? await loadConfig(configPath) : await loadConfigMultiLayer();
  /** 한 번 쓰고 끝나는 프로세스라 보관 결과를 다시 읽을 수 없다. 행을 줄이지 않는다. */
  return { ...config, output: { ...(config.output ?? DEFAULT_OUTPUT), auto_retain_rows: 0 } };
}

/** 응답 봉투를 셸 출력처럼 바꾼다 */
export function renderForShell(envelope: ResponseEnvelope, preferParsed = false): ExecOutcome {
  const parsed  = envelope.stdout.parsed;
  const rawText = envelope.stdout.raw;
  let   out     = rawText;
  if (parsed !== null && parsed !== undefined) {
    const json = JSON.stringify(parsed);
    /**
     * 원문이 없으면(파싱 성공으로 원문을 뺀 경우) JSON을 쓴다. 둘 다 있으면 짧은 쪽을 쓴다.
     * 시험 러너·린터는 기계용 형식으로 실행했으므로 원문은 사람이 읽는 출력이 아니다. 항상 파싱 결과를 쓴다.
     */
    out = preferParsed || rawText === "" || Buffer.byteLength(json) < Buffer.byteLength(rawText) ? `${json}\n` : rawText;
  }
  let err = envelope.stderr.raw;
  /** 가드나 설정 거절은 명령이 실행되지 않았다는 사실과 대안을 표준 오류로 알린다. */
  if (envelope.failure && (envelope.failure.kind === "guard" || envelope.failure.kind === "config")) {
    err = `[parism] ${envelope.failure.message}${envelope.failure.suggestion ? `\n[parism] ${envelope.failure.suggestion}` : ""}\n`;
  }
  const exitCode = envelope.failure?.kind === "guard" || envelope.failure?.kind === "config" ? 126 : envelope.exitCode;
  return { stdout: out, stderr: err, exitCode };
}

/** 조각 하나(파이프 포함)를 실행한다. 시험 러너와 린터는 기계용 출력 형식으로 실행해 실패 목록을 받는다. */
async function runSegment(engine: ParismEngine, command: string, cwd: string): Promise<ExecOutcome & { pipeStatus: number[] }> {
  const resolved = resolveCommand("", { command, cwd });
  const runner   = resolved.ok && resolveRunner(resolved.cmd, resolved.args) !== null;
  const envelope = await engine.run("", {
    /** 원문과 파싱 결과 가운데 짧은 쪽을 고르려면 원문이 있어야 한다. */
    command, cwd, delivery: "shell", include_raw: true,
    ...(runner && { contract_version: "next" as const, machine_format: true }),
  });
  const shown = renderForShell(envelope, runner);
  const stages = resolved.ok && resolved.pipeline ? resolved.pipeline.stages.length : 0;
  return { ...shown, pipeStatus: [shown.exitCode, ...Array<number>(stages).fill(0)] };
}

/**
 * 명령 한 줄을 실행한다. `;`, `&&`, `||`로 이은 명령 목록은 셸과 같은 규칙으로 차례로 실행한다.
 * `cd <dir>` 조각은 다음 조각의 작업 디렉터리를 바꾸고, `$?`와 `${PIPESTATUS[N]}`는 앞 조각의 종료 코드로 바꾼다.
 * 종료 코드는 마지막으로 실행한 조각의 것이다.
 */
export async function execCommand(command: string, options: { cwd?: string; config?: string } = {}): Promise<ExecOutcome> {
  const config   = await configForExec(options.config);
  const engine   = new ParismEngine(config, createRegistry());
  const segments = splitSequence(command) ?? [{ text: command }];
  let cwd        = options.cwd ?? process.cwd();
  let last       = 0;
  let pipeStatus = [0];
  let stdout     = "";
  let stderr     = "";
  for (const segment of segments) {
    if (segment.op === "&&" && last !== 0) continue;
    if (segment.op === "||" && last === 0) continue;
    const text  = substituteStatus(segment.text, last, pipeStatus);
    const lexed = lexCommand(text);
    if (lexed.ok && lexed.cmd === "cd" && lexed.pipeline.length === 0) {
      const target = path.resolve(lexed.cwd ? path.resolve(cwd, lexed.cwd) : cwd, lexed.args[0] ?? os.homedir());
      if (existsSync(target) && statSync(target).isDirectory()) { cwd = target; last = 0; }
      else { stderr += `cd: ${lexed.args[0]}: No such file or directory\n`; last = 1; }
      pipeStatus = [last];
      continue;
    }
    const outcome = await runSegment(engine, text, cwd);
    stdout    += outcome.stdout;
    stderr    += outcome.stderr;
    last       = outcome.exitCode;
    pipeStatus = outcome.pipeStatus;
  }
  return { stdout, stderr, exitCode: last };
}
