import { describe, it, expect, afterEach } from "vitest";
import { existsSync, readdirSync, rmSync, mkdirSync } from "node:fs";
import { join }                    from "node:path";
import { homedir }                 from "node:os";
import { tmpdir }                  from "node:os";
import { expandTilde, defaultFixturesDir } from "../../src/cli/paths.js";
import { createCli }               from "../../src/cli.js";

/**
 * 결함 A-18 — `parism capture` 가 "저장했다" 고 말하면서 저장하지 않던 것.
 *
 * ## 실측
 *
 *   $ parism capture "git status --porcelain"
 *   Fixture saved: ~/.parism/fixtures/git-20261005-163612.json
 *   Exit code: 0
 *   $ ls ~/.parism/fixtures/
 *   ls: cannot access '~/.parism/fixtures/': No such file or directory
 *   $ find . -name 'git-2026*'
 *   ./~/.parism/fixtures/git-20261005-163612.json
 *
 * `--output` 기본값이 **문자열** `"~/.parism/fixtures"` 였다. 셸이 아니라 Node 라서
 * `~` 가 전개되지 않는다. 그래서 fixture 가 **작업 디렉터리 안의 `~` 폴더**에 쓰였다.
 * 메시지가 집 경로처럼 보여서 사용자는 저장됐다고 믿었고, README 가 안내하는 다음 단계
 * `parism test ~/.parism/fixtures` 는 그 파일을 찾지 못했다. 회귀 고리가 끊긴다.
 *
 * ## 이 시험이 왜 필요한가
 *
 * `captureCommand()` 를 직접 부르는 시험으로는 이 결함을 잡지 못한다. 함수는
 * `fixturesDir` 를 받는 순간부터 정상이다. **CLI 가 뭐를 넘겨주는지**만 봐야 한다.
 * 그래서 여기서는 `createCli()` 를 실제로 실행해 cwd 를 바꿔 두고 관측한다.
 *
 * "파일 하나가 있다" 만 확인하면 조기 반환할 수 있다. `~` 폴더가 생겼는지도 함께 본다 —
 * 그게 이 결함의 실제 형태이기 때문이다.
 */

describe("결함 A-18 — capture 가 저장하지 않던 것", () => {
  const root     = join(tmpdir(), `parism-a18-${process.pid}-${Date.now()}`);
  const workDir  = join(root, "work");
  const homeDir  = join(root, "home");

  afterEach(() => {
    if (existsSync(root)) rmSync(root, { recursive: true });
    delete process.env.PARISM_HOME;
  });

  it("기본값으로 실행하면 홈의 fixtures 에 실제로 쓰인다", async () => {
    mkdirSync(workDir, { recursive: true });
    process.env.PARISM_HOME = homeDir;
    const cwd = process.cwd();
    process.chdir(workDir);
    try {
      await createCli().parseAsync(["node", "parism", "capture", "git status --porcelain"]);

      const fixtures = join(homeDir, "fixtures");
      expect(existsSync(fixtures), "PARISM_HOME/fixtures 에 저장되지 않았다").toBe(true);
      expect(readdirSync(fixtures).filter(f => f.endsWith(".json")).length).toBeGreaterThan(0);
    } finally {
      process.chdir(cwd);
    }
  }, 30_000);

  it("작업 디렉터리에 `~` 폴더를 만들지 않는다", async () => {
    mkdirSync(workDir, { recursive: true });
    process.env.PARISM_HOME = homeDir;
    const cwd = process.cwd();
    process.chdir(workDir);
    try {
      await createCli().parseAsync(["node", "parism", "capture", "git status --porcelain"]);

      /** 결함의 실제 형태다. "저장됐다"고 말하면서 프로젝트 밑에 `~` 가 생겼다. */
      expect(existsSync(join(workDir, "~")), "작업 디렉터리에 `~` 폴더가 생겼다").toBe(false);
    } finally {
      process.chdir(cwd);
    }
  }, 30_000);

  it("`--output '~/...'` 를 명시해도 전개된다", async () => {
    mkdirSync(workDir, { recursive: true });
    const cwd = process.cwd();
    process.chdir(workDir);
    try {
      /** env 를 건드리지 않고 `~` 인자로만 확인한다. */
      const home = await import("node:os").then(m => m.homedir());
      const target = join(home, `.parism-a18-tilde-${process.pid}`);
      try {
        await createCli().parseAsync([
          "node", "parism", "capture", "git status --porcelain", "--output", `~/.parism-a18-tilde-${process.pid}`,
        ]);
        expect(existsSync(join(target, "..")) || true).toBe(true);
        const written = readdirSync(target).filter(f => f.endsWith(".json"));
        expect(written.length, "~/ 로 준 경로가 전개되지 않았다").toBeGreaterThan(0);
      } finally {
        if (existsSync(target)) rmSync(target, { recursive: true, force: true });
      }
    } finally {
      process.chdir(cwd);
    }
  }, 30_000);
});

describe("expandTilde()", () => {
  it("`~` 와 `~/` 를 홈으로 펼친다", () => {
    expect(expandTilde("~")).toBe(homedir());
    expect(expandTilde("~/x/y")).toBe(join(homedir(), "x/y"));
    expect(expandTilde("~\\x")).toBe(join(homedir(), "x"));
  });

  it("`~` 로 시작하지 않으면 그대로 둔다", () => {
    expect(expandTilde("/abs/path")).toBe("/abs/path");
    expect(expandTilde("rel/path")).toBe("rel/path");
    expect(expandTilde("/a/~/b")).toBe("/a/~/b");
  });

  it("기본 fixture 경로에는 `~` 가 없다 — 문자열이 아니라 실제 경로다", () => {
    expect(defaultFixturesDir()).not.toContain("~");
    expect(defaultFixturesDir().endsWith("/fixtures")).toBe(true);
  });
});

