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
 * `~` 로 시작하는 경로를 실제 홈 디렉토리로 펼친다.
 *
 * ## 왜 필요한가 — 실측으로 잡은 결함
 *
 * `parism capture` 의 `--output` 기본값이 **문자열** `"~/.parism/fixtures"` 였다.
 * 셸이 아니라 Node 라서 `~` 가 전개되지 않는다. 그래서 `mkdirSync` 가 **작업 디렉터리
 * 안에 `~` 라는 이름의 디렉터리를 만들었다.**
 *
 *   $ parism capture "git status --porcelain"
 *   Fixture saved: ~/.parism/fixtures/git-20261005-163612.json   ← 집이 아니라 프로젝트 밑
 *   Exit code: 0
 *   $ ls ~/.parism/fixtures/
 *   ls: cannot access '~/.parism/fixtures/': No such file or directory
 *
 * 메시지가 집 경로처럼 보여서 **사용자는 저장됐다고 믿는다.** 실제로는 저장된 게 아니라
 * 프로젝트 폴더에 `~` 디렉터리가 생겼고, README 가 안내하는 다음 단계
 * (`parism test ~/.parism/fixtures`) 는 그 파일을 찾지 못한다. 회귀 고리가 끊긴다.
 * **"저장했다" 고 말하면서 저장하지 않은 것**이라 조용히 손실이다.
 *
 * 명시적으로 `--output '~/x'` 를 준 경우도 같은 이유로 고장 나므로 여기서 함께 푼다.
 */
export function expandTilde(target: string): string {
  if (target === "~")                        return homedir();
  if (target.startsWith("~/") || target.startsWith("~\\")) {
    return join(homedir(), target.slice(2));
  }
  return target;
}

/** 기본값이 없을 때 쓰는 fixture 디렉토리. `~` 가 아니라 실제 경로다. */
export function defaultFixturesDir(): string {
  return join(parismHome(), "fixtures");
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
