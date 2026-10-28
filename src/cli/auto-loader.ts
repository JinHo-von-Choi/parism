import { existsSync, readFileSync } from "node:fs";
import { join }                     from "node:path";
import type { ParserRegistry }      from "../parsers/registry.js";
import type { PrismParsersConfig, ExternalCapabilityConfig } from "../config/loader.js";
import { EXTERNAL_PARSER_DEFAULTS } from "../config/loader.js";
import { loadIsolatedPack }         from "../parsers/external/host.js";
import { loadParserPack }           from "./loader.js";
import { isValidPackName, invalidPackNameMessage } from "./paths.js";

/**
 * 외부 파서 로드 옵션. 지정하지 않은 값은 EXTERNAL_PARSER_DEFAULTS를 따른다.
 * isolation     -- worker: 팩마다 워커 스레드에서 읽고 실행한다. none: 서버 스레드에서 읽고 실행한다.
 * timeLimitMs   -- worker일 때 호출 한 번의 시간 상한
 * memoryLimitMb -- worker일 때 워커 힙 상한
 */
export interface ExternalParserOptions {
  isolation?:     "worker" | "none";
  timeLimitMs?:   number;
  memoryLimitMb?: number;
  /** 샌드박스에 열어 줄 capability. 비우면 **전부 거부한다**. */
  capabilities?:  ExternalCapabilityConfig;
}

/** 설정의 parsers 값을 로더 옵션으로 옮긴다. */
export function externalParserOptions(parsers: PrismParsersConfig | undefined): ExternalParserOptions {
  return {
    ...(parsers?.external_isolation       !== undefined && { isolation:     parsers.external_isolation }),
    ...(parsers?.external_time_limit_ms   !== undefined && { timeLimitMs:   parsers.external_time_limit_ms }),
    ...(parsers?.external_memory_limit_mb !== undefined && { memoryLimitMb: parsers.external_memory_limit_mb }),
    ...(parsers?.external_capabilities    !== undefined && { capabilities:  parsers.external_capabilities }),
  };
}

/**
 * ~/.parism/registry.json을 읽고 등록된 외부 파서를 레지스트리에 로드한다.
 * 기본은 워커 격리다. 팩 모듈은 워커에서만 실행되고 레지스트리에는 계약 선언과 실행 대리만 등록된다.
 * 이름 형식이 맞지 않는 항목과 로드 실패한 파서는 건너뛰고 경고 출력. 반환값: 성공 로드 수.
 */
export async function loadExternalParsers(
  parismHome: string,
  registry:   ParserRegistry,
  options:    ExternalParserOptions = {},
): Promise<number> {
  const registryPath = join(parismHome, "registry.json");
  if (!existsSync(registryPath)) return 0;

  let entries: Record<string, { path: string }>;
  try {
    entries = JSON.parse(readFileSync(registryPath, "utf-8"));
  } catch {
    return 0;
  }

  const isolation = options.isolation ?? EXTERNAL_PARSER_DEFAULTS.external_isolation;
  const limits    = {
    timeLimitMs:   options.timeLimitMs   ?? EXTERNAL_PARSER_DEFAULTS.external_time_limit_ms,
    memoryLimitMb: options.memoryLimitMb ?? EXTERNAL_PARSER_DEFAULTS.external_memory_limit_mb,
  };

  /**
   * 샌드박스에 열어 줄 capability.
   *
   * **비어 있으면 전부 거부한다**(fail-closed). 기본값이 빈 객체이므로
   * 아무도 명시하지 않은 호스트에서는 파일도 환경 변수도 없다.
   */
  const capabilities = options.capabilities ?? EXTERNAL_PARSER_DEFAULTS.external_capabilities;
  /** 게스트가 볼 수 있는 시크릿은 **이름뿐**이다. 값은 샌드박스 밖에 있다. */
  const secrets = Object.keys(process.env).filter(name => /TOKEN|SECRET|PASSWORD|CREDENTIAL/i.test(name));

  let loaded = 0;
  for (const [name, entry] of Object.entries(entries)) {
    if (!isValidPackName(name)) {
      console.warn(`[parism] Skipped parser entry in registry.json: ${invalidPackNameMessage(name)}`);
      continue;
    }
    try {
      if (isolation === "worker") {
        registry.registerIsolated(loadIsolatedPack(entry.path, limits, capabilities, secrets));
      }
      else                        registry.registerPack(await loadParserPack(entry.path));
      loaded++;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[parism] Failed to load parser "${name}": ${msg}`);
    }
  }

  return loaded;
}
