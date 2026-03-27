import { execFile }    from "node:child_process";
import { writeFileSync, mkdirSync } from "node:fs";
import { join }        from "node:path";
import { promisify }   from "node:util";
import { parismHome }  from "./paths.js";

const execFileAsync = promisify(execFile);

export interface CaptureResult {
  exitCode:    number;
  fixturePath: string;
}

function timestamp(): string {
  const d   = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-` +
         `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

/**
 * 명령어를 실행하고 stdout/stderr/exitCode를 fixture JSON으로 저장한다.
 */
export async function captureCommand(
  cmd:  string,
  args: string[],
  fixturesDir?: string,
): Promise<CaptureResult> {
  const dir = fixturesDir ?? join(parismHome(), "fixtures");
  mkdirSync(dir, { recursive: true });

  let stdout   = "";
  let stderr   = "";
  let exitCode = 0;

  try {
    const result = await execFileAsync(cmd, args, {
      timeout:   30_000,
      maxBuffer: 10 * 1024 * 1024,
    });
    stdout = result.stdout;
    stderr = result.stderr;
  } catch (err: unknown) {
    const execErr = err as { stdout?: string; stderr?: string; code?: number };
    stdout   = execErr.stdout ?? "";
    stderr   = execErr.stderr ?? "";
    exitCode = execErr.code ?? 1;
  }

  const fixture = {
    command:     cmd,
    args,
    stdout,
    stderr,
    exitCode,
    captured_at: new Date().toISOString(),
  };

  const filename    = `${cmd}-${timestamp()}.json`;
  const fixturePath = join(dir, filename);
  writeFileSync(fixturePath, JSON.stringify(fixture, null, 2));

  return { exitCode, fixturePath };
}
