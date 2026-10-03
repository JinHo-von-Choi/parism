import { cpSync, mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { loadIsolatedPack } from "../parsers/external/host.js";
import { EXTERNAL_PARSER_DEFAULTS } from "../config/loader.js";
import { ensureParismDirs, packInstallDir, parismHome as defaultHome } from "./paths.js";

export interface AddResult {
  name:        string;
  installedTo: string;
}

/**
 * 팩을 워커에서 읽어 이름을 확인한다. 팩 모듈은 이 스레드에서 실행하지 않는다.
 */
async function readPackName(packDir: string): Promise<string> {
  const pack = loadIsolatedPack(packDir, {
    timeLimitMs:   EXTERNAL_PARSER_DEFAULTS.external_time_limit_ms,
    memoryLimitMb: EXTERNAL_PARSER_DEFAULTS.external_memory_limit_mb,
  });
  await pack.close();
  return pack.name;
}

/**
 * 파서 팩을 ~/.parism/parsers/에 복사하고 registry.json에 등록한다.
 * 팩 이름은 디렉터리를 만들기 전에 형식을 검사한다(paths.ts의 isValidPackName).
 */
export async function addParserPack(
  sourcePath: string,
  parismHome?: string,
): Promise<AddResult> {
  const name    = await readPackName(resolve(sourcePath));
  const destDir = packInstallDir(parismHome ?? defaultHome(), name);
  const home    = ensureParismDirs(parismHome);

  mkdirSync(destDir, { recursive: true });
  cpSync(resolve(sourcePath), destDir, { recursive: true });

  const registryPath = join(home, "registry.json");
  const registry: Record<string, { path: string; addedAt: string }> =
    existsSync(registryPath)
      ? JSON.parse(readFileSync(registryPath, "utf-8"))
      : {};

  registry[name] = {
    path:    destDir,
    addedAt: new Date().toISOString(),
  };

  writeFileSync(registryPath, JSON.stringify(registry, null, 2));

  return { name, installedTo: destDir };
}
