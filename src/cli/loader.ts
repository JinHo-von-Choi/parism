import { existsSync }    from "node:fs";
import { join }          from "node:path";
import { pathToFileURL } from "node:url";
import type { ParserPack } from "../parsers/registry.js";

/**
 * 디렉토리에서 parser.js를 동적 import로 로드한다.
 */
export async function loadParserPack(packDir: string): Promise<ParserPack> {
  const parserPath = join(packDir, "parser.js");

  if (!existsSync(parserPath)) {
    throw new Error(`parser.js not found in ${packDir}`);
  }

  const mod  = await import(pathToFileURL(parserPath).href);
  const pack = mod.default;

  if (!pack || typeof pack.name !== "string" || typeof pack.parse !== "function") {
    throw new Error(`Invalid default export in ${parserPath} -- must be a ParserPack`);
  }

  return pack as ParserPack;
}
