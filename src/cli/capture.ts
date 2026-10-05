import { execFile }    from "node:child_process";
import { writeFileSync, mkdirSync } from "node:fs";
import { join }        from "node:path";
import { promisify }   from "node:util";
import { parismHome }  from "./paths.js";
import { contentHashOf, FIXTURE_MANIFEST_VERSION, type FixtureManifest } from "../fixtures/manifest.js";
import { sanitizeArgs, sanitizeText } from "../fixtures/sanitize.js";

const execFileAsync = promisify(execFile);

export interface CaptureResult {
  exitCode:    number;
  fixturePath: string;
  /** 가려진 것의 수. '저장했다'는 말만으로는 무엇이 나갔는지 알 수 없다. */
  redactions:  number;
  manifest:    FixtureManifest;
}

function timestamp(): string {
  const d   = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-` +
         `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

/** 파일명 한 글자도 조용히 바꾸지 않는다 — 무엇이 들어갔는지 알 수 있어야 한다. */
function slug(text: string): string {
  return text.replace(/[^A-Za-z0-9._-]+/g, "-").slice(0, 60);
}

/**
 * 명령어를 실행하고 **정제한** stdout/stderr/exitCode 를 fixture 매니페스트로 저장한다.
 *
 * ## 왜 정제하는가 — 계획서 8장 "정제본", "마스킹 때문에 바뀐 필드도 명시한다"
 *
 * 예전에는 출력을 그대로 적었다. `kubectl get pods -o wide` 나 `systemctl status` 출력에는
 * 호스트명, 홈 경로, 내부 IP, 토큰이 섞여 나오고, 그 파일을 이슈에 붙이는 순간 원문이 퍼진다.
 *
 * 지금은 저장하기 전에 가리고 **무엇을 가렸는지** 를 `redactions` 에 남긴다.
 * 가린 흔적이 없으면 나중에 '원래 없던 것인지 가린 것인지' 구분할 수 없다.
 *
 * ## 기대값은 이 함수에서 만들지 않는다
 *
 * 캡처는 재생만 한다. `expected` 는 사람이 직접 채워야 하고, 그때 `reviewed_by` 가 들어간다.
 * 여기서 기대값을 자동으로 채우면 '기계가 확인했으므로 맞다' 는 거짓말이 된다.
 */
export async function captureCommand(
  cmd:  string,
  args: string[],
  fixturesDir?: string,
): Promise<CaptureResult> {
  const dir = fixturesDir ?? join(parismHome(), "fixtures");
  mkdirSync(dir, { recursive: true });

  let stdout:   string;
  let stderr:   string;
  let exitCode: number;

  try {
    const result = await execFileAsync(cmd, args, {
      timeout:   30_000,
      maxBuffer: 10 * 1024 * 1024,
    });
    stdout   = result.stdout;
    stderr   = result.stderr;
    exitCode = 0;
  } catch (err: unknown) {
    const execErr = err as { stdout?: string; stderr?: string; code?: number };
    stdout   = execErr.stdout ?? "";
    stderr   = execErr.stderr ?? "";
    exitCode = execErr.code ?? 1;
  }

  const cleanOut   = sanitizeText(stdout);
  const cleanErr   = sanitizeText(stderr);
  const cleanArgs  = sanitizeArgs(args);
  const redactions = [...cleanOut.redactions, ...cleanErr.redactions, ...cleanArgs.redactions];

  const manifest: FixtureManifest = {
    manifest_version: FIXTURE_MANIFEST_VERSION,
    id:                `${slug(cmd)}-${timestamp()}`,
    captured_at:       new Date().toISOString(),
    tool: { command: cmd, args: cleanArgs.args, ...(cleanArgs.redacted && { args_redacted: true }) },
    exit: { code: exitCode },
    stdout:            cleanOut.text,
    stderr:            cleanErr.text,
    content_hash:      contentHashOf(cleanOut.text),
    versions:          { platform: process.platform },
    redactions,
  };

  const filename    = `${manifest.id}.json`;
  const fixturePath = join(dir, filename);
  writeFileSync(fixturePath, JSON.stringify(manifest, null, 2));

  return { exitCode, fixturePath, redactions: redactions.reduce((sum, r) => sum + r.count, 0), manifest };
}
