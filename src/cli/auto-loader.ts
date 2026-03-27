import { existsSync, readFileSync } from "node:fs";
import { join }                     from "node:path";
import type { ParserRegistry }      from "../parsers/registry.js";
import { loadParserPack }           from "./loader.js";

/**
 * ~/.parism/registry.json을 읽고 등록된 외부 파서를 레지스트리에 로드한다.
 * 로드 실패한 파서는 건너뛰고 경고 출력. 반환값: 성공 로드 수.
 */
export async function loadExternalParsers(
  parismHome: string,
  registry:   ParserRegistry,
): Promise<number> {
  const registryPath = join(parismHome, "registry.json");
  if (!existsSync(registryPath)) return 0;

  let entries: Record<string, { path: string }>;
  try {
    entries = JSON.parse(readFileSync(registryPath, "utf-8"));
  } catch {
    return 0;
  }

  let loaded = 0;
  for (const [name, entry] of Object.entries(entries)) {
    try {
      const pack = await loadParserPack(entry.path);
      registry.registerPack(pack);
      loaded++;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[parism] Failed to load parser "${name}": ${msg}`);
    }
  }

  return loaded;
}
