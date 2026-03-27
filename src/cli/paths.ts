import { mkdirSync } from "node:fs";
import { homedir }   from "node:os";
import { join }      from "node:path";

/**
 * Parism 홈 디렉토리 경로. PARISM_HOME 환경변수 우선, 없으면 ~/.parism.
 */
export function parismHome(): string {
  return process.env.PARISM_HOME ?? join(homedir(), ".parism");
}

/**
 * ~/.parism/ 하위 디렉토리 구조를 보장한다.
 */
export function ensureParismDirs(base?: string): string {
  const home = base ?? parismHome();
  mkdirSync(join(home, "fixtures"), { recursive: true });
  mkdirSync(join(home, "parsers"),  { recursive: true });
  return home;
}
