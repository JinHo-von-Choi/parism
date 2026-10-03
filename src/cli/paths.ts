import { mkdirSync }                  from "node:fs";
import { homedir }                    from "node:os";
import { join, isAbsolute, relative } from "node:path";

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

/** 파서 팩 이름 형식: 영문자나 숫자로 시작하고 영문자, 숫자, '.', '_', '-'로 된 1~64자 */
const PACK_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** 파서 팩 이름이 설치 디렉터리 이름과 registry.json 키로 쓸 수 있는 형식인지 */
export function isValidPackName(name: string): boolean {
  return PACK_NAME_PATTERN.test(name);
}

/** 형식 밖의 파서 팩 이름을 알리는 메시지 */
export function invalidPackNameMessage(name: string): string {
  return `Invalid parser pack name ${JSON.stringify(name)}: use 1 to 64 letters, digits, '.', '_' or '-', starting with a letter or digit`;
}

/**
 * home 아래 파서 팩 설치 디렉터리 경로. 이름 형식이 맞지 않거나 경로가 parsers/ 바로 아래가 아니면 예외를 던진다.
 * 디렉터리는 만들지 않는다.
 */
export function packInstallDir(home: string, name: string): string {
  if (!isValidPackName(name)) throw new Error(invalidPackNameMessage(name));
  const parsersDir = join(home, "parsers");
  const destDir    = join(parsersDir, name);
  const rel        = relative(parsersDir, destDir);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel) || rel !== name) throw new Error(invalidPackNameMessage(name));
  return destDir;
}
