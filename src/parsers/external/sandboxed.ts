/**
 * 샌드박스 안에서 실행되는 외부 ParserPack.
 *
 * ## 워커 경로와 무엇이 다른가
 *
 * | | 워커 격리 | 샌드박스 |
 * |---|----------|--------|
 * | 성격 | **결함 격리** | **보안 경계** |
 * | 파일 접근 | 워커의 권한 그대로 | **열어 준 경로만** |
 * | 네트워크 | 워커의 권한 그대로 | **없음** |
 * | 환경 변수 | 워커의 권한 그대로 | **열어 준 것만** |
 * | 메모리 | 워커 힙 상한 | 게스트 선형 메모리 상한 |
 * | 시간 | 워커 임계값 | **Wasmtime epoch 타임아웃** |
 *
 * 워커는 **같은 프로세스의 권한**을 가진다. 그건 결함을 막기 위한 것이지
 * 신뢰 경계를 만들기 위한 것이 아니다.
 *
 * ## 팩 형식
 *
 * 샌드박스 경로는 팩 디렉터리에서 두 파일을 읽는다.
 *
 * ```
 * <packDir>/parser.wasm      — Wasmtime 컴포넌트
 * <packDir>/contract.json    — 계약 선언 (데이터만)
 * ```
 *
 * 계약은 **데이터만** 담는다. `supports` 같은 함수는 JSON에 없으므로,
 * 샌드박스 팩은 `required_flags` 로 "이 플래그가 있어야 한다" 만 표현한다.
 *
 * ## 게스트가 돌려주는 것
 *
 * 게스트는 `parse(raw) -> result<json, error>` 를 구현한다. 성공하면 **JSON 문자열**을 돌려준다.
 * 레지스트리는 그 문자열을 파싱해 결과로 쓴다.
 *
 * 작성자: 최진호
 * 작성일: 2026-10-22
 */

import { existsSync, readFileSync } from "node:fs";
import { join }                   from "node:path";

import { UnrecognizedOutputError, type IsolatedParser, type IsolatedParseResult,
         type ParseContext, type ParserContract } from "../registry.js";
import { runSandboxed, type ExternalCapabilities } from "./sandbox.js";

/** 샌드박스 팩의 계약 선언 파일. */
const CONTRACT_FILE = "contract.json";

/** 샌드박스 팩의 컴포넌트 파일. */
const COMPONENT_FILE = "parser.wasm";

/** 샌드박스 경로를 쓸 수 있는 팩 디렉터리인가. */
export function isSandboxPack(packDir: string): boolean {
  return existsSync(join(packDir, COMPONENT_FILE));
}

/**
 * 샌드박스 팩의 계약 선언.
 *
 * 정규식 필드는 **패턴 문자열**로 적는다. JSON 에 RegExp 를 넣을 수는 없다.
 */
interface SandboxContractFile {
  name?:             string;
  acceptedFlags?:    Record<string, "bool" | "value">;
  requiredFlags?:    string[];
  acceptedValues?:   Record<string, string>;
  rowsKey?:          string;
  rowFields?:        string[];
  headerLines?:      number;
}

/** 계약 파일을 읽어 계약으로 바꾼다. */
function readContract(packDir: string): { name: string; contract: ParserContract } {
  const file = join(packDir, CONTRACT_FILE);
  if (!existsSync(file)) {
    throw new Error(`External parser in ${packDir} has ${COMPONENT_FILE} but no ${CONTRACT_FILE}`);
  }
  let parsed: SandboxContractFile;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8")) as SandboxContractFile;
  } catch (err) {
    throw new Error(`External parser contract in ${file} is not valid JSON: ${(err as Error).message}`, { cause: err });
  }

  const contract: ParserContract = {
    ...(parsed.acceptedFlags ? { acceptedFlags: parsed.acceptedFlags } : {}),
    ...(parsed.requiredFlags ? { requiredFlags: parsed.requiredFlags } : {}),
    ...(parsed.acceptedValues ? {
      acceptedValues: Object.fromEntries(
        Object.entries(parsed.acceptedValues).map(([flag, pattern]) => [flag, new RegExp(pattern)]),
      ),
    } : {}),
    ...(parsed.rowsKey     ? { rowsKey: parsed.rowsKey } : {}),
    ...(parsed.rowFields  ? { rowFields: parsed.rowFields } : {}),
    ...(parsed.headerLines !== undefined ? { headerLines: parsed.headerLines } : {}),
  };

  return { name: parsed.name ?? "sandbox-pack", contract };
}

/**
 * 샌드박스 안에서 실행되는 외부 ParserPack.
 */
class SandboxedPackHost implements IsolatedParser {
  readonly name:     string;
  readonly contract: ParserContract;
  private readonly component: string;

  constructor(
    packDir:     string,
    private readonly timeoutMs: number,
    private readonly capabilities: ExternalCapabilities,
    private readonly secrets: string[],
  ) {
    const { name, contract } = readContract(packDir);
    this.name      = name;
    this.contract  = contract;
    this.component = join(packDir, COMPONENT_FILE);
  }

  /**
   * 게스트를 부른다.
   *
   * 게스트는 JSON 문자열을 돌려준다. JSON 이 아니면 **실패** 다 —
   * 조용히 빈 결과로 바꾸면 안 된다. 무엇이 잘못됐는지 소비자가 알아야 한다.
   */
  parse(args: string[], raw: string, _ctx: ParseContext | undefined, _strictSchemas: boolean): IsolatedParseResult {
    const result = runSandboxed({
      component:  this.component,
      raw,
      timeoutMs: this.timeoutMs,
      capabilities: this.capabilities,
      secrets: this.secrets,
    });

    if (!result.ok) {
      const message = result.message ?? "external parser sandbox failed";
      /** 게스트가 "이 형식은 모른다" 고 말한 경우 — 인식 실패로 분류한다. */
      if (result.failure === "guest_error") throw new UnrecognizedOutputError(message);
      throw new Error(`External parser '${this.name}' ${message}`);
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(result.value ?? "") as unknown;
    } catch (err) {
      throw new Error(`External parser '${this.name}' did not return JSON: ${(err as Error).message}`, { cause: err });
    }
    return { parsed };
  }

  async close(): Promise<void> {
    /** 샌드박스 프로세스는 공유한다 — 여기서 끝내지 않는다. */
  }
}

/**
 * 샌드박스 팩을 불러 격리 파서를 만든다.
 */
export function loadSandboxedPack(
  packDir:      string,
  timeoutMs:    number,
  capabilities: ExternalCapabilities = {},
  secrets:      string[] = [],
): IsolatedParser {
  return new SandboxedPackHost(packDir, timeoutMs, capabilities, secrets);
}
