/**
 * `@nerdvana/parism/sdk` 시험. 실제 명령을 실행해 타입 있는 결과를 받는다.
 *
 * 작성자: 최진호
 * 작성일: 2026-11-12
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createShell } from "../src/sdk/index.js";

let repo: string;
let cfg:  string;

beforeAll(() => {
  repo = mkdtempSync(path.join(tmpdir(), "parism-sdk-"));
  execFileSync("git", ["init", "-q"], { cwd: repo });
  writeFileSync(path.join(repo, "a.txt"), "a\n");
  execFileSync("git", ["add", "-A"], { cwd: repo });
  execFileSync("git", ["-c", "user.email=t@example.invalid", "-c", "user.name=t", "commit", "-qm", "first commit"], { cwd: repo });
  writeFileSync(path.join(repo, "b.txt"), "b\n");
  cfg = path.join(repo, "..", `${path.basename(repo)}.json`);
  writeFileSync(cfg, JSON.stringify({ guard: { allowed_paths: [repo] } }));
});

afterAll(() => {
  rmSync(repo, { recursive: true, force: true });
  rmSync(cfg, { force: true });
});

describe("sh", () => {
  it("git.status, git.log, ls, exec가 파싱된 값을 돌려준다", async () => {
    const sh = createShell({ configPath: cfg, cwd: repo });
    const status = await sh.git.status();
    expect(status.ok).toBe(true);
    expect(status.data?.untracked).toEqual(["b.txt"]);

    const log = await sh.git.log({ n: 5 });
    expect(log.data?.commits[0]).toMatchObject({ message: "first commit", author: "t" });

    const ls = await sh.ls(".", { where: [{ field: "type", op: "eq", value: "file" }], select: ["name"] });
    expect(ls.data?.entries.map(e => e.name).sort()).toEqual(["a.txt", "b.txt"]);

    const piped = await sh.exec<{ count: number }>("git log --oneline | wc -l");
    expect(piped.data?.count).toBe(1);
  });

  it("가드 거절은 예외가 아니라 실패 결과다", async () => {
    const sh = createShell({ configPath: cfg, cwd: repo });
    const r  = await sh.exec("rm -rf a.txt");
    expect(r.ok).toBe(false);
    expect(r.failure?.kind).toBe("guard");
  });
});
