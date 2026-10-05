import { describe, it, expect }    from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath }           from "node:url";
import { dirname, join }           from "node:path";
import { PACKAGE_VERSION }         from "../src/version.js";

/**
 * 버전이 세 곳에 적혀 있다 — `package.json`, `package-lock.json`, `src/version.ts`.
 *
 * ## 왜 시험이 필요한가
 *
 * `src/version.ts` 는 순환 의존을 피하려고 분리된 **복사본**이다. 한쪽만 올리면
 * 조용히 어긋난다. 어느 쪽이 뒤처지면:
 *
 *   - `src/version.ts` 가 뒤처지면 `describe().version` 이 실제 배포본과 다른 값을 말한다.
 *     **버전을 물어보는 도구가 거짓말을 한다.**
 *   - `package.json` 이 뒤처지면 npm 이 이전 버전으로 배포된다.
 *
 * 둘 다 조용히 깨진다. 그래서 한쪽만 올리는 것이 **오류가 아니라 정상처럼 보이기** 때문에
 * 시험으로 막는다.
 */
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

function readJson(relativePath: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(repoRoot, relativePath), "utf-8"));
}

describe("버전이 어긋나지 않는다", () => {
  const pkg       = readJson("package.json");
  const lock      = readJson("package-lock.json");
  const lockRoot  = (lock.packages as Record<string, Record<string, unknown>>)[""];

  it("PACKAGE_VERSION 이 package.json 의 version 과 같다", () => {
    expect(PACKAGE_VERSION).toBe(pkg.version);
  });

  it("package-lock.json 의 두 곳이 package.json 과 같다", () => {
    expect(lock.version).toBe(pkg.version);
    expect(lockRoot?.version).toBe(pkg.version);
  });

  it("npm 이 싣는 dist 가 현재 버전을 말한다 (dist 가 있을 때만)", () => {
    /**
     * `dist/` 는 커밋되지 않지만 **tarball 은 `files: ["dist"]` 로 dist 만 싣는다.**
     * 그러므로 배포본에서 나오는 값은 dist 다. 소스만 고치고 빌드 안 하면 배포본이 옛말을 한다.
     * 빌드 전인 환경에서는 검사를 건너뛴다 — 없는 걸 실패로 세지 않는다.
     */
    const distPath = join(repoRoot, "dist", "version.js");
    if (!existsSync(distPath)) return;
    expect(readFileSync(distPath, "utf-8")).toContain(`PACKAGE_VERSION = "${pkg.version}"`);
  });
});
