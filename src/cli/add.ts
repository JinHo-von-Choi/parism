import { cpSync, mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { loadParserPack } from "./loader.js";
import { ensureParismDirs } from "./paths.js";

export interface AddResult {
  name:        string;
  installedTo: string;
}

/**
 * 파서 팩을 ~/.parism/parsers/에 복사하고 registry.json에 등록한다.
 */
export async function addParserPack(
  sourcePath: string,
  parismHome?: string,
): Promise<AddResult> {
  const pack    = await loadParserPack(resolve(sourcePath));
  const home    = ensureParismDirs(parismHome);
  const destDir = join(home, "parsers", pack.name);

  mkdirSync(destDir, { recursive: true });
  cpSync(resolve(sourcePath), destDir, { recursive: true });

  const registryPath = join(home, "registry.json");
  const registry: Record<string, { path: string; addedAt: string }> =
    existsSync(registryPath)
      ? JSON.parse(readFileSync(registryPath, "utf-8"))
      : {};

  registry[pack.name] = {
    path:    destDir,
    addedAt: new Date().toISOString(),
  };

  writeFileSync(registryPath, JSON.stringify(registry, null, 2));

  return { name: pack.name, installedTo: destDir };
}
