/**
 * 외부 파서 샌드박스 — TypeScript 쪽 다리.
 *
 * ## 왜 프로세스 경계를 넘는가
 *
 * 샌드박스는 Wasmtime 위에서 돈다. Node 안에는 Wasmtime 이 없다 — **Rust 크레이트**다.
 * 그러므로 샌드박스 호출은 프로세스를 넘어야 한다.
 *
 * ## 왜 파일로 왕복하는가
 *
 * 레지스트리의 `parse` API 는 **동기**다. 외부 팩을 부를 때마다 비동기로 돌릴 수 없다.
 * 그런데 프로세스 경계는 비동기다.
 *
 * 동기 함수가 프로세스를 기다리는 방법을 셋 비교했다.
 *
 * | 방법 | 동작 | 판정 |
 * |------|------|------|
 * | 표준 출력을 `fs.readSync` 로 읽기 | 파이프 fd 를 블로킹 읽기 | **Windows 파이프에서 동작하지 않는다** |
 * | 표준 출력 이벤트 + `Atomics.wait` | 이벤트 루프가 죽어 이벤트를 못 받는다 | **불가능** |
 * | **응답을 파일로 받기** | 파일이 생길 때까지 폴링 | **모든 플랫폼에서 된다** |
 *
 * 그래서 파일이다. 요청은 JSON 파일, 응답도 JSON 파일이고 경로는 표준 입력으로 한 줄 준다.
 *
 * ## 이 다리가 보장하는 것
 *
 * - 게스트는 **호스트가 열어 준 것만** 요구할 수 있다.
 * - 게스트는 **시간·메모리·연료** 상한을 넘을 수 없다.
 * - 호출 사이에 **공유 상태가 없다** (호스트 쪽에서 매번 새 인스턴스를 만든다).
 *
 * ## 이 다리가 보장하지 않는 것
 *
 * - **OS 샌드박스가 아니다.** 커널 격리가 아니다.
 * - **메모리 안전 언어의 한계가 남는다.** 게스트 안의 로직 취약점은 그대로다.
 *
 * 작성자: 최진호
 * 작성일: 2026-10-22
 */

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { createRequire }                          from "node:module";
import { tmpdir }                                from "node:os";
import { join, resolve }                         from "node:path";
import { fileURLToPath }                          from "node:url";

/** 게스트에 열어 주는 capability. */
export interface ExternalCapabilities {
  /** 읽기만 허용할 파일 시스템 경로. (호스트 경로, 게스트가 보는 경로) */
  fsRead?: Array<[string, string]>;
  /** 노출할 환경 변수. */
  env?:   Array<[string, string]>;
}

/** 샌드박스 호출 결과. */
export interface SandboxResult {
  /** 성공했는가. */
  ok:         boolean;
  /** 게스트가 돌려준 결과. */
  value?:     string;
  /** 게스트가 `log` 로 남긴 것. */
  logs?:      string[];
  /** 실패 종류. */
  failure?:   string;
  /** 실패 이유. */
  message?:   string;
}

/** 샌드박스 호출 옵션. */
export interface SandboxOptions {
  /** 컴포넌트 파일 경로. */
  component:    string;
  /** 원문. */
  raw:          string;
  /** 호출 시간 상한(ms). */
  timeoutMs?:   number;
  /** 허용 capability. 비우면 **전부 거부**한다. */
  capabilities?: ExternalCapabilities;
  /** 시크릿 **이름** 목록. 값은 넘기지 않는다 — 값은 샌드박스 밖에 있다. */
  secrets?:     string[];
  /** 메모리 상한(바이트). */
  memoryBytes?: number;
  /** 연료 예산. */
  fuel?:        number;
}

/** 샌드박스 바이너리를 찾지 못했다. */
export class SandboxUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SandboxUnavailableError";
  }
}

/** 이 호스트의 샌드박스 바이너리 경로. 없으면 undefined. */
export function resolveSandboxBinary(): string | undefined {
  /** 명시된 지정이 우선한다. 없으면 조용히 다른 곳을 찾지 않는다. */
  const explicit = process.env.PARISM_SANDBOX_BIN;
  if (explicit) return existsSync(explicit) ? explicit : undefined;

  /** npm 플랫폼 패키지가 설치된 경우. */
  try {
    const require = createRequire(import.meta.url);
    const pkg = require.resolve(`@nerdvana/parism-sandbox-${process.platform}-${process.arch}/package.json`);
    const candidate = join(resolve(pkg, ".."), "bin", "parism-sandbox");
    if (existsSync(candidate)) return candidate;
  } catch {
    /** 플랫폼 패키지가 없다. 다음 후보를 본다. */
  }

  /** 개발 중 — 저장소 안에서 직접 빌드한 바이너리. */
  // dist/parsers/external/ 에서 세 단계 올라가야 저장소 루트다.
  const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
  const candidate = join(repoRoot, "crates", "parism-sandbox", "target", "release", "parism-sandbox");
  return existsSync(candidate) ? candidate : undefined;
}

/** 잠깐 쉬는用的 공유 배열. `Atomics.wait` 는 이 위에서 쉰다. */
const SLEEP_SLOT = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));

/** 지정한 밀리초 동안 현재 스레드를 쉰다. 동기 대기를 위한 것. */
function sleepSync(ms: number): void {
  if (ms <= 0) return;
  Atomics.wait(SLEEP_SLOT, 0, 0, ms);
}

/** 샌드박스 프로세스 하나. 요청은 순서대로 처리된다. */
class SandboxProcess {
  private child: ChildProcessWithoutNullStreams | null = null;
  private failed: string | null = null;

  /** 프로세스를 띄우거나, 이미 있으면 그 processes 돌려준다. */
  private ensure(binary: string): ChildProcessWithoutNullStreams {
    if (this.failed) throw new SandboxUnavailableError(this.failed);
    if (this.child) return this.child;

    const child = spawn(binary, [], { stdio: ["pipe", "pipe", "pipe"] });
    /**
     * 실행 권한이 없거나 파일이 없으면 pid 없이 돌아오고, 오류는 다음 틱에야 온다.
     * 이 자식을 보관하면 안 된다. 응답을 기다리는 동안 이벤트 루프가 멈춰 오류가 처리되지 않은 채로
     * `kill()` 하면 Node 는 pid 0 으로 신호를 보낸다 — 이 프로세스 그룹 전체가 SIGTERM 을 받는다.
     */
    if (child.pid === undefined) {
      child.on("error", () => { /** 위에서 실패로 처리했다. */ });
      this.failed = `외부 파서 샌드박스를 실행할 수 없다: ${binary}`;
      throw new SandboxUnavailableError(this.failed);
    }
    /**
     * 부모가 샌드박스 때문에 죽지 않게 한다.
     * 샌드박스는 보조 수단이다 — 이것이 남아 있다고 서버가 종료되지 않아야 한다.
     */
    child.unref();
    for (const stream of [child.stdin, child.stdout, child.stderr]) {
      const handle = stream as unknown as { ref?: () => void; unref?: () => void };
      handle.unref?.();
    }
    child.on("error", (err: Error) => { this.failed = err.message; });
    child.on("exit", () => { this.child = null; });
    /** 표준 출력은 프로토콜에 쓰지 않는다 — 진단용으로만 읽는다. */
    child.stdout.resume();
    child.stderr.resume();

    this.child = child;
    return child;
  }

  /** 요청 파일을 보내고 응답 파일이 생길 때까지 기다린다. */
  run(requestPath: string, responsePath: string, timeoutMs: number): string {
    const binary = resolveSandboxBinary();
    if (!binary) {
      throw new SandboxUnavailableError(
        "외부 파서 샌드박스 바이너리를 찾지 못했다 (PARISM_SANDBOX_BIN 으로 경로를 지정하거나 crates/parism-sandbox 을 빌드하세요)",
      );
    }
    const child = this.ensure(binary);
    child.stdin.write(`${requestPath}\n`);

    const deadline = performance.now() + timeoutMs;
    for (;;) {
      if (existsSync(responsePath)) {
        try {
          return readFileSync(responsePath, "utf8");
        } finally {
          try { unlinkSync(responsePath); } catch { /** 이미 없다. */ }
        }
      }
      if (performance.now() >= deadline) {
        throw new Error(`외부 파서 샌드박스가 ${timeoutMs} ms 안에 답하지 않았다`);
      }
      sleepSync(5);
    }
  }

  /** 프로세스를 끝낸다. */
  close(): void {
    const child = this.child;
    this.child = null;
    if (!child) return;
    try { child.stdin.end(); } catch { /** 이미 끝났다. */ }
    /** pid 가 없거나 이미 끝난 자식에게 신호를 보내지 않는다. pid 0 신호는 프로세스 그룹 전체로 간다. */
    if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
    try { child.kill(); } catch { /** 이미 죽었다. */ }
  }
}

/** 프로세스 하나를 공유한다. 컴포넌트 컴파일 비용 때문에 호출마다 새로 띄우지 않는다. */
let shared: SandboxProcess | null = null;

/** 테스트를 위해 프로세스를 버린다. */
export function resetSandboxProcess(): void {
  shared?.close();
  shared = null;
}

/**
 * 외부 팩을 샌드박스 안에서 한 번 부른다.
 *
 * 성공하면 `ok: true` 와 `value` 를 돌려준다.
 * 실패하면 `ok: false` 와 `failure`·`message` 를 돌려준다.
 */
export function runSandboxed(options: SandboxOptions): SandboxResult {
  const timeoutMs = options.timeoutMs ?? 500;
  const dir     = mkdtempSync(join(tmpdir(), "parism-sandbox-"));
  const request = join(dir, "request.json");
  const response = `${request}.response`;

  const body = {
    component:    options.component,
    raw:          options.raw,
    timeout_ms:   timeoutMs,
    memory_bytes: options.memoryBytes ?? 10 * 1024 * 1024,
    fuel:         options.fuel ?? 500_000_000,
    fs_read:      options.capabilities?.fsRead ?? [],
    env:          options.capabilities?.env ?? [],
    secrets:      options.secrets ?? [],
  };

  try {
    writeFileSync(request, JSON.stringify(body), "utf8");
    shared ??= new SandboxProcess();
    const text = shared.run(request, response, timeoutMs + 2000);
    const parsed = JSON.parse(text) as SandboxResult;
    return parsed;
  } catch (err) {
    return {
      ok: false,
      failure: "unavailable",
      message: (err as Error).message,
    };
  } finally {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /** 남은 것은 무시한다. */ }
  }
}
